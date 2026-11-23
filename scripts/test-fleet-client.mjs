import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setImmediate} from 'node:timers/promises';
import {createFleetPlugin,draftRecreationPrompt} from '../src/fleet-client.js';
import {isIncompatibleDraft,validatePlan} from '../src/fleet-model.js';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createFleetViews,workspaceFileTarget,fileHref,deliveryGapInfo,applyGatePolicy,applyTaskContract,applyDeliveryTarget} from '../src/fleet-ui.js';
import {fleetTranslator} from '../src/fleet-locale.js';

const response = body => ({ok:true,json:async()=>body});
const view = (workspaceId,tickets=[]) => ({schemaVersion:1,workspaceId,catalog:{agents:[],orchestrations:[],binding:null,availablePresets:[]},tickets,selectedTicket:null,health:{ready:true,error:null}});
async function harness(t,{fail=false,fetcher,createSession,draftResult='applied',sidebar=false,drafts=[]}={}){
 const elements=[],calls=[],disposers=[],requests=[];let enabled=['w1','w2'];
 const original=globalThis.fetch;globalThis.fetch=async(url,options)=>{requests.push({url,options});if(url.startsWith('/api/fleet/drafts'))return response({schemaVersion:1,workspaceId:'w1',drafts,selectedDraft:drafts.at(-1)??null});if(url.startsWith('/api/fleet/view'))return fetcher?fetcher(url,options):response(view(new URL(url,'http://fixture').searchParams.get('workspaceId')));if(url==='/api/fleet/action')return fetcher(url,options);if(options.method==='POST'){const change=JSON.parse(options.body);enabled=enabled.filter(id=>id!==change.workspaceId);if(change.enabled)enabled.push(change.workspaceId);}return response({schemaVersion:1,enabledWorkspaceIds:enabled});};
 t.after(()=>{globalThis.fetch=original;for(const dispose of disposers.reverse())dispose?.();});
 const workspaces={items:[{workspaceId:'w1',sessionIds:['s1'],path:'G:/one'},{workspaceId:'w2',sessionIds:[],path:'G:/two'}]};
 const sessions={byId:{s1:{title:'Existing session'}}};
  let panelState={activePanelId:null};const panelListeners=new Set();
 const dictionaries=new Map(),localeListeners=new Set(),localeSnapshot={active:'zh'};
 const locale={getSnapshot:()=>localeSnapshot,subscribe:listener=>{localeListeners.add(listener);return()=>localeListeners.delete(listener);},register:(namespace,values)=>{dictionaries.set(namespace,values);return()=>dictionaries.delete(namespace);},bind:namespace=>(key,parameters={})=>(dictionaries.get(namespace)?.zh?.[key]??key).replace(/\{(\w+)\}/g,(match,name)=>Object.hasOwn(parameters,name)?String(parameters[name]):match)};
 const ctx={effect(fn){disposers.push(fn());},uiWorkspace:{startSession(id,options){calls.push(['start-session',id,options]);},openSession(id){calls.push(['session',id]);},async openWorkspace(id){calls.push(['workspace',id]);if(fail)throw Error('Workspace unavailable');}},locale,workspaces:{list:{getSnapshot:()=>workspaces}},sessions:{list:{getSnapshot:()=>sessions},async create(args){calls.push(['create-session',args]);return createSession?createSession(args):'fresh-session';},binding:sessionId=>({sessionId})},conversation:{input:{requestDraftInitialization(binding,options){calls.push(['initialize-draft',binding,options]);return draftResult;}}},layout:{panelInfo:{getSnapshot:()=>panelState,subscribe:listener=>{panelListeners.add(listener);return()=>panelListeners.delete(listener);}},selectPanel:id=>{calls.push(['panel',id]);panelState={activePanelId:id};for(const listener of panelListeners)listener();}},...(sidebar?{sidebarRight:{mounted:{getSnapshot:()=>'s1',subscribe:()=>()=>{}},openResource:address=>calls.push(['resource',address])},sidebarRightTabs:{register:()=>()=>{}}}:{}),slots:{inject(name,fn){const result=fn();if(result?.[Symbol.iterator])for(const dispose of result)disposers.push(dispose);else disposers.push(result);},register(options,component){const element={options,component};elements.push(element);return ()=>{const index=elements.indexOf(element);if(index>=0)elements.splice(index,1);};},provideRoot(){throw Error('Fleet must never replace native root hooks');}}};
 const react={createElement:(type,props,...children)=>({type,props:props??{},children}),Fragment:'fragment',useRef:()=>({current:null}),useEffect:()=>{}};
 createFleetPlugin(()=>react).apply(ctx);await setImmediate();
 function render(id,address){const row=elements.find(e=>e.options.id===id||e.options.key===id);const hooks=row.options.inject?.('s1').hooks??{};const props={t:locale.bind(row.options.locale),sessionId:'s1',useTabInfo:()=>({tab:{navigation:{address}}})};for(const [name,store]of Object.entries(hooks))props['use'+name[0].toUpperCase()+name.slice(1)]=select=>select(store.getSnapshot());return row.component(props);}
 function all(tree){return tree&&typeof tree==='object'?[tree,...(tree.children??[]).flat(Infinity).flatMap(all)]:[];}
 function button(tree,key,value){return all(tree).find(n=>n.type==='button'&&(value===undefined?n.children.includes(key):n.props[key]===value));}
 function settings(){button(render('dsh-fleet-control'),'data-fleet-root-tab','settings').props.onClick();return render('dsh-fleet-control');}
 function open(id='w1'){button(settings(),'data-fleet-open',id).props.onClick();return render('dsh-fleet');}
 return {calls,requests,render,all,button,open,settings,elements};
}

test('Control opens an independent Dashboard without touching the current Session',async t=>{
 const h=await harness(t);const dashboard=h.open();assert.deepEqual(h.calls,[['panel','dsh-fleet']]);
 assert.equal(dashboard.props['data-fleet-panel-workspace-id'],'w1');assert.ok(h.all(dashboard).some(n=>n.props['data-fleet-session']==='s1'));
});
test('Another Workspace Dashboard does not create or navigate a Session',async t=>{
 const h=await harness(t);const dashboard=h.open('w2');assert.deepEqual(h.calls,[['panel','dsh-fleet']]);assert.equal(dashboard.props['data-fleet-panel-workspace-id'],'w2');
});
test('Workspace mode changes do not navigate Chat or Dashboard',async t=>{
 const h=await harness(t);h.button(h.settings(),'data-fleet-toggle','w1').props.onClick();await setImmediate();assert.equal(h.button(h.render('dsh-fleet-control'),'data-fleet-open','w1'),undefined);assert.deepEqual(h.calls,[]);
});
test('Only explicit Open chat navigates a native Session',async t=>{
 const h=await harness(t);h.button(h.open(),'打开对话').props.onClick();assert.deepEqual(h.calls,[['panel','dsh-fleet'],['session','s1']]);
});
test('Create Ticket prefills the canonical /fleet new command without a modal or prepare request',async t=>{
  const h=await harness(t);await h.button(h.open(),'新建任务').props.onClick();
  assert.deepEqual(h.calls,[['panel','dsh-fleet'],['create-session',{workspaceId:'w1'}],['session','fresh-session'],['initialize-draft',{sessionId:'fresh-session'},{prompt:'/fleet new ',whenDraftExists:'keep'}]]);
  assert.equal(h.all(h.render('dsh-fleet')).some(node=>node.type==='dialog'),false);
  assert.equal(h.requests.filter(row=>row.options.method==='POST').length,0);
});
test('repeated Create Ticket clicks share one pending native creation',async t=>{
  let finish;const h=await harness(t,{createSession:()=>new Promise(resolve=>{finish=resolve;})});
  const click=h.button(h.open(),'新建任务').props.onClick;const first=click();await click();
  assert.equal(h.calls.filter(row=>row[0]==='create-session').length,1);finish('fresh-session');await first;
  assert.equal(h.calls.filter(row=>row[0]==='initialize-draft').length,1);
});
test('late native creation does not navigate after user changes Dashboard workspace',async t=>{
  let finish;const h=await harness(t,{createSession:()=>new Promise(resolve=>{finish=resolve;})});
  const first=h.button(h.open(),'新建任务').props.onClick();h.open('w2');finish('fresh-session');await first;
  assert.equal(h.calls.some(row=>row[0]==='session'||row[0]==='initialize-draft'),false);
});
test('blocked native draft initialization preserves input and surfaces a Dashboard error',async t=>{
  const h=await harness(t,{draftResult:'preserved'});await h.button(h.open(),'新建任务').props.onClick();
  assert.ok(h.all(h.render('dsh-fleet')).some(node=>node.props.role==='alert'&&node.children.some(text=>typeof text==='string'&&text.includes('已有输入已保留'))));
});
test('Return from Dashboard selects Conversation without navigating a Session',async t=>{
 const h=await harness(t);h.button(h.open(),'返回对话').props.onClick();assert.deepEqual(h.calls,[['panel','dsh-fleet'],['panel',null]]);
});
test('Explicit new-chat failure stays visible in the Dashboard',async t=>{
 const h=await harness(t,{fail:true});await h.button(h.open('w2'),'新建工作区对话').props.onClick();assert.ok(h.all(h.render('dsh-fleet')).some(n=>n.props.role==='alert'&&n.children.some(text=>typeof text==='string'&&text.includes('Workspace unavailable'))));
});
test('Fleet registers only additive panels and never disables the native Workspace provider',async t=>{
 const h=await harness(t);assert.deepEqual([...new Set(h.elements.map(e=>e.options.name))].sort(),['conversation.view','main','sidebar.panellist']);
 const patch=await readFile('cordis.patch.yml','utf8');assert.doesNotMatch(patch,/ui-workspace|disabled:/);
 const generated=await readFile('client.js','utf8');assert.doesNotMatch(generated,/createWorkspacePlugin|class UiWorkspace|sidebar\.workspaces\.workspace\.item/);
});

const sampleTicket=(workspaceId,id,status='running')=>({workspaceId,id,originSessionId:'s1',revision:1,status,plan:{contractVersion:3,goal:id,inputs:{},deliverables:[],criteria:[],agents:{},nodes:[],gates:[]},execution:null,activity:[]});
const contains=(h,label)=>h.all(h.render('dsh-fleet')).some(node=>node.children.includes(label));
const realViews=createFleetViews(React);
const canonical=()=>({...sampleTicket('w1','canonical','draft'),plan:{contractVersion:3,goal:'Canonical goal',inputs:{nested:{location:'local-input'},sources:['first','second']},deliverables:['Separate artifact'],criteria:['First line\nsecond line'],requirements:'Retain requirements',agents:{writer:{name:'Local writer',profile:{agentPreset:'preset-old',instructions:'Local profile'}}},nodes:[{id:'A',role:'same role',agentId:'writer',dependsOn:[],task:{prompt:'Ticket task A',context:{key:'value'}}},{id:'B',role:'same role',agentId:'writer',dependsOn:[],task:{prompt:'Ticket task B'}}],gates:[{id:'review',from:['A'],to:['B'],reviewer:{kind:'human'}}]}});
const dashboard=(ticket,ui={},catalog={})=>renderToStaticMarkup(realViews.renderDashboard({workspace:{workspaceId:'w1',title:'Fixture',path:'G:/fixture'},enabled:true,ui:{page:'ticket',ticketId:ticket.id,...ui},data:{ready:true,tickets:[ticket],catalog,pluginVersion:'0.5.0'},mode:{},t:fleetTranslator('en'),language:'en',sessions:[],navigate(){},act(){},openDialog(){},setUI(){},drafts:{},writeDraft(){},sendMessage(){},refresh(){}}));
test('real Dashboard reads the Ticket plan even when a catalog template has the same ID',()=>{
  const ticket=canonical(),html=dashboard(ticket,{}, {binding:{orchestrationId:'canonical'},orchestrations:[{id:'canonical',definition:{nodes:[{id:'WRONG',role:'other',task:{prompt:'Wrong catalog plan'}}],gates:[]}}]});
  assert.match(html,/Ticket task A/);assert.match(html,/Separate artifact/);assert.match(html,/Retain requirements/);assert.match(html,/v0\.5\.0/);assert.doesNotMatch(html,/Wrong catalog plan/);
  assert.match(html,/data-fleet-flow-level="0"[\s\S]*Ticket task A[\s\S]*◇ review[\s\S]*data-fleet-flow-level="1"[\s\S]*Ticket task B/);
});
test('real historical Node details use the selected attempt configuration and separate Node/Agent IDs',()=>{
  const ticket=canonical(),old=structuredClone(ticket.plan);ticket.status='running';ticket.plan.agents.writer.profile.instructions='Newest profile';
  ticket.execution={currentConfigRevision:2,configurations:{1:{revision:1,plan:old,sourceRefs:[]},2:{revision:2,plan:ticket.plan,sourceRefs:[]}},nodes:{A:{status:'running',thread:[],attempts:[{id:'old-attempt',configRevision:1,status:'completed',sessionId:'history-session'},{id:'new-attempt',configRevision:2,status:'running',sessionId:'current-session'}]},B:{status:'pending',thread:[],attempts:[]}},gates:{review:{status:'pending',reviews:[],history:[]}}};
  const html=dashboard(ticket,{nodeId:'A',attemptId:'old-attempt'});
  assert.match(html,/Local profile/);assert.doesNotMatch(html,/Newest profile/);assert.match(html,/Node ID/);assert.match(html,/Agent ID/);assert.match(html,/history-session/);assert.doesNotMatch(html,/Edit this task|Edit draft/);
  ticket.status='stopped';assert.match(dashboard(ticket,{nodeId:'A'}),/Edit draft/);
});
test('Root template linked execution uses explicit frozen provenance rather than same local IDs',()=>{
  const ticket=canonical();ticket.status='stopped';
  ticket.execution={currentConfigRevision:2,configurations:{1:{plan:structuredClone(ticket.plan),sourceRefs:[{kind:'agent',templateId:'writer',templateRevision:7,localId:'writer'},{kind:'orchestration',templateId:'flow-template',templateRevision:4,nodeIds:['A','B']}]},2:{plan:structuredClone(ticket.plan),sourceRefs:[]}},nodes:{A:{status:'completed',thread:[],attempts:[{id:'sourced',configRevision:1,status:'completed',sessionId:'linked-history'},{id:'same-id-only',configRevision:2,status:'completed',sessionId:'must-not-link'}]}},gates:{}};
  const catalog={agents:[{id:'writer',revision:9,name:'Root writer',profile:{instructions:'Template instructions'},source:{templateId:'source-template',templateRevision:2},history:[]}],orchestrations:[{id:'flow-template',revision:5,definition:{nodes:ticket.plan.nodes,gates:ticket.plan.gates},source:{templateId:'source-flow',templateRevision:3},history:[]}]};
  const agent=dashboard(ticket,{page:'agent',agentId:'writer'},catalog);assert.match(agent,/linked-history/);assert.doesNotMatch(agent,/must-not-link/);assert.match(agent,/source-template/);
  const flow=dashboard(ticket,{page:'orchestration',flowId:'flow-template'},catalog);assert.match(flow,/canonical · v1/);assert.doesNotMatch(flow,/canonical · v2/);assert.match(flow,/source-flow/);
});
const evidenceTicket=()=>{
  const ticket=sampleTicket('w1','evidence-static','running');
  ticket.plan={contractVersion:3,goal:'Evidence display',inputs:{deliveryTarget:'deliverables'},deliverables:['Report file','Summary notes'],criteria:['Reproducible verification'],
    agents:{writer:{name:'Writer',profile:{agentPreset:'standard',instructions:'Write with sources.'}}},
    nodes:[{id:'build',role:'writer',agentId:'writer',dependsOn:[],task:{prompt:'Write the report',contract:{acceptance:['Sourced conclusions'],scope:{in:['report/'],out:['fleet configuration']},verify:['check.py']}}},{id:'review',role:'reviewer',agentId:'writer',dependsOn:[],task:{prompt:'Review the report'}}],
    gates:[{id:'quality',from:['build'],to:[],reviewer:{kind:'human'},requireEvidence:true,rework:{maxRounds:2}},{id:'autocheck',from:['build'],to:[],reviewer:{kind:'agent',nodeId:'review'},rework:{maxRounds:2}}]};
  const sha=v=>v.repeat(64);
  ticket.execution={currentConfigRevision:1,configurations:{1:{revision:1,plan:structuredClone(ticket.plan),rules:{},sourceRefs:[]}},
    nodes:{build:{status:'completed',thread:[],attempts:[{id:'a1',configRevision:1,status:'completed',sessionId:'fs1',startedAt:'2026-11-16T00:00:00.000Z',finishedAt:'2026-11-16T00:05:00.000Z',outputs:{ok:true},completion:{submittedAt:'2026-11-16T00:20:00.000Z',evidenceKind:'agent-report',summary:'Report complete.',acceptanceResults:[{criterion:'Sourced conclusions',status:'passed',evidence:'Appendix A'}],verification:[{command:'check.py',exitCode:0,output:'OK',source:'agent-report'}],artifactRefs:[{artifactId:'art1',version:2,sha256:sha('b')}]}}]},review:{status:'pending',thread:[],attempts:[]}},
    gates:{quality:{status:'passed',configRevision:1,cycle:0,reviews:[{id:'r1',time:'2026-11-16T00:15:00.000Z',decision:'passed',cycle:0,actor:{kind:'human',userId:'u'},evidence:'Reviewed v1.',artifactRefs:[{artifactId:'art1',version:1,sha256:sha('a')}],bindingKind:'explicit'}],humanOverride:null,history:[]},
      autocheck:{status:'returned',configRevision:1,cycle:1,autoReworkRounds:2,reviews:[{id:'r2',time:'2026-11-16T00:25:00.000Z',decision:'returned',cycle:1,actor:{kind:'agent',nodeId:'review'},evidence:'Missing sources.',findings:[{id:'f1',severity:'high',description:'Missing sources'}],artifactRefs:[],bindingKind:null}],humanOverride:null,history:[]}},
    artifacts:{art1:{nodeId:'build',deliverableIndex:0,label:'Report file',sourcePath:'report/final.md',versions:[{version:1,sha256:sha('a'),size:10,mediaType:'text/markdown',snapshotPath:'.fleet/tickets/x/artifacts/art1/v1/final.md',attemptId:'a1',configRevision:1,submittedAt:'2026-11-16T00:10:00.000Z'},{version:2,sha256:sha('b'),size:20,mediaType:'text/markdown',snapshotPath:'.fleet/tickets/x/artifacts/art1/v2/final.md',attemptId:'a1',configRevision:1,submittedAt:'2026-11-16T00:20:00.000Z'}]}},
    deliverables:{0:{artifactId:'art1',label:'Report file'}},delivery:{history:[],override:null}};
  ticket.activity=[];
  return ticket;
};
test('a selected pending review node directly shows model and effort controls in its thread',()=>{
  const ticket=evidenceTicket();
  const catalog={agents:[],orchestrations:[],modelCatalog:{default:{provider:'host',model:'default'},groups:[{id:'host',models:[{id:'default',reasoning:{efforts:[{id:'high'}]}}]}]}};
  const pending=dashboard(ticket,{nodeId:'review'},catalog);
  assert.match(pending,/data-fleet-thread="review"[\s\S]*data-fleet-thread-model="review"[\s\S]*data-fleet-ticket-model="review"[\s\S]*data-fleet-model-menu-trigger="seat"[\s\S]*data-fleet-model-row="model"[\s\S]*data-fleet-model-row="effort"/);
  assert.doesNotMatch(pending,/data-fleet-thread-feed|fl-composer/);
  assert.doesNotMatch(pending,/保存模型设置|Save model settings|fl-node-model-editor/);
  const missing=structuredClone(ticket);missing.plan.nodes.find(n=>n.id==='review').modelSelection={provider:'host',model:'retired'};
  const retired=dashboard(missing,{nodeId:'review'},catalog);
  assert.match(retired,/data-fleet-model-menu-trigger="seat"[^>]*>[\s\S]*?retired[\s\S]*?Not in catalog/);
  assert.match(retired,/data-fleet-model-row="inherit"/);
  assert.doesNotMatch(pending,/Edit model \/ effort/);
  assert.doesNotMatch(dashboard(ticket,{nodeId:'build'},catalog),/data-fleet-ticket-model=/);
  assert.doesNotMatch(dashboard(ticket,{gateTicketId:ticket.id,gateId:'quality'},catalog),/data-fleet-ticket-(?:gate-)?model=/);
  const draft={...ticket,status:'draft',execution:null};
  const gate=dashboard(draft,{gateTicketId:draft.id,gateId:'autocheck'},catalog);
  assert.match(gate,/data-fleet-ticket-gate-model="autocheck"[\s\S]*data-fleet-model-menu-trigger="seat"/);
  assert.doesNotMatch(gate,/Shared model settings|data-fleet-ticket-model=/);
});
test('evidence projection renders completion facts, stale coverage, rework budget and deliverable links',()=>{
  const html=dashboard(evidenceTicket(),{nodeId:'build'});
  for(const value of ['Execution finished','Submitted · self-reported','Completion evidence (self-reported, not host-verified)','Sourced conclusions','Appendix A','Verification records (agent-reported; not host-verified)','exit 0','Task contract (acceptance / scope / verify)'])assert.ok(html.includes(value),value);
  const ticket=evidenceTicket();
  const quality=dashboard(ticket,{gateTicketId:ticket.id,gateId:'quality'});
  const auto=dashboard(ticket,{gateTicketId:ticket.id,gateId:'autocheck'});
  for(const value of ['Re-review needed','The artifact has been updated; the review verdict does not cover the latest version.','Reviewed versions','art1 v1','Structured evidence required','Human returns · unlimited rework','Review passed'])assert.ok(quality.includes(value),value);
  for(const value of ['Auto rework 2/2','Budget exhausted','Review inputs','Checks','Planned use'])assert.ok(auto.includes(value),value);
  assert.doesNotMatch(auto.split('data-fleet-rawdata=')[0],/Return findings|Missing sources/);
  assert.match(auto.split('data-fleet-rawdata=')[1],/Missing sources/);
  for(const value of ['Delivery target','Report file','Summary notes','Unbound','No artifact submitted yet','Open location ↗'])assert.ok(html.includes(value),value);
  assert.match(html,/data-fleet-completion="a1"/);assert.match(quality,/data-fleet-gate-coverage="quality"/);assert.match(auto,/data-fleet-rework="autocheck"/);assert.match(html,/data-fleet-deliverable="0"/);
  assert.match(quality,/data-fleet-review-artifact="art1"/);assert.match(quality,/Report complete./);
  assert.doesNotMatch(html,/data-fleet-gate-inspector=/);assert.doesNotMatch(quality,/data-fleet-gate-inspector="autocheck"/);
  assert.doesNotMatch(dashboard(ticket,{gateTicketId:'another-ticket',gateId:'quality'}),/data-fleet-gate-inspector=/);
  assert.match(html,/data-fleet-todo="quality"/);assert.doesNotMatch(auto,/data-fleet-todo="autocheck"/);
  const missing=evidenceTicket();delete missing.execution.nodes.build.attempts[0].completion;
  const restricted=dashboard(missing);
  assert.match(restricted,/<button[^>]*disabled=""[^>]*data-fleet-todo-approve="quality"/);
  assert.match(restricted,/<button(?:(?!disabled)[^>])*data-fleet-todo-reject="quality"/);
  for(const status of ['stopped','delivered']){
    const history=dashboard({...ticket,status},{gateTicketId:ticket.id,gateId:'quality'});
    assert.match(history,/data-fleet-gate-inspector="quality"/);assert.doesNotMatch(history,/data-fleet-todo=|data-fleet-review-passed=/);
  }
  const draft=canonical();const preview=dashboard(draft,{gateTicketId:draft.id,gateId:'review'});
  assert.match(preview,/data-fleet-gate-inspector="review"/);assert.doesNotMatch(preview,/data-fleet-todo=|data-fleet-review-passed=/);
  // Mid-run (review node pending, autocheck returned) is not the settlement edge: no override exit yet.
  assert.ok(!html.includes('Human delivery override'),'override must not appear before the settlement edge');
  // Real /api/file anchors (never fake links): deliverable row, artifact ref chip.
  assert.match(html,/<a href="api\/file\?path=[^"]+"[^>]*data-fleet-deliverable-link="0"/);assert.match(html,/href="api\/file\?path=G%3A%2Ffixture%2F\.fleet/);assert.match(html,/data-fleet-artifact-link="art1"/);
  assert.ok(!html.includes('No structured evidence'),'submitted evidence must not show the missing-evidence label');
});
test('settlement edge with a stale verdict shows the blocked notice and the human override exit',()=>{
  const ticket=evidenceTicket();
  ticket.execution.nodes.review={status:'completed',thread:[],attempts:[]};
  ticket.execution.gates.autocheck={...ticket.execution.gates.autocheck,status:'passed'};
  const html=dashboard(ticket,{nodeId:'build'});
  for(const value of ['Delivery is blocked','Stale review','Human delivery override','The artifact has been updated; the review verdict does not cover the latest version.'])assert.ok(html.includes(value),value);
  assert.match(html,/data-fleet-delivery-blocked="evidence-static"/);assert.match(html,/data-fleet-deliver-override="evidence-static"/);
});
test('human override shows its targeted versions and unbound deliverables never fake a location',()=>{
  const ticket=evidenceTicket();
  ticket.execution.gates.quality={...ticket.execution.gates.quality,status:'passed',humanOverride:{id:'o1',time:'2026-11-16T00:30:00.000Z',actor:{kind:'human',userId:'u'},priorStatus:'returned',decision:'passed',configRevision:1,cycle:0}};
  const html=dashboard(ticket,{gateTicketId:ticket.id,gateId:'quality'});
  assert.ok(html.includes('Human override recorded (bound art1 v2, now art1 v2)'),html.slice(0,200));
  assert.ok(html.includes('Reviewed'));
  const noEvidence=evidenceTicket();delete noEvidence.execution.nodes.build.attempts[0].completion;
  const missing=dashboard(noEvidence,{nodeId:'build'});
  assert.ok(missing.includes('No structured evidence'));assert.ok(missing.includes('This attempt submitted no structured completion evidence'));
});
test('workspaceFileTarget builds absolute /api/file targets and rejects unsafe or unknown paths',()=>{
  assert.equal(workspaceFileTarget('G:/ws','.fleet/a/b.md'),'G:/ws/.fleet/a/b.md');
  assert.equal(workspaceFileTarget('G:\\ws\\','report\\final.md'),'G:/ws/report/final.md');
  assert.equal(fileHref('G:/ws/a b.md'),'api/file?path=G%3A%2Fws%2Fa%20b.md');
  for(const bad of ['../escape.md','/abs.md','C:/abs.md','a/../b.md','a\u0000b.md',''])assert.equal(workspaceFileTarget('G:/ws',bad),null,bad);
  assert.equal(workspaceFileTarget(undefined,'a.md'),null);assert.equal(workspaceFileTarget('G:/ws',undefined),null);
});
test('deliveryGapInfo gates override to the settlement edge and lists unbound/stale/pending gaps',()=>{
  const base={status:'running',nodes:[{status:'completed'}],gates:[{id:'q',status:'passed',coverage:'stale'}],deliverables:[{index:0,label:'A',artifactId:'x'},{index:1,label:'B'}],delivery:{history:[],override:null}};
  const gap=deliveryGapInfo(base);
  assert.deepEqual(gap.unbound,[{index:1,label:'B'}]);assert.deepEqual(gap.staleGates,['q']);
  assert.equal(gap.allCompleted,true);assert.equal(gap.allPassed,true);assert.equal(gap.blocked,true);assert.equal(gap.canOverride,true);
  // Mid-run (a node still running) must not offer override even with gaps.
  assert.equal(deliveryGapInfo({...base,nodes:[{status:'running'}]}).canOverride,false);
  // A passed gate without stale and fully bound deliverables is not blocked.
  assert.equal(deliveryGapInfo({...base,gates:[{id:'q',status:'passed',coverage:'covered'}],deliverables:[{index:0,label:'A',artifactId:'x'}]}).blocked,false);
  // Pending export blocks; an existing override clears the block.
  assert.equal(deliveryGapInfo({...base,delivery:{pending:{},history:[],override:null}}).pendingExport,true);
  assert.equal(deliveryGapInfo({...base,delivery:{history:[],override:{reason:'r'}}}).blocked,false);
});
test('applyGatePolicy/applyTaskContract/applyDeliveryTarget produce save-valid plans and reject bad shapes',()=>{
  const plan={contractVersion:3,goal:'g',inputs:{},deliverables:[],criteria:[],agents:{},nodes:[{id:'build',agentId:'w',dependsOn:[],task:{prompt:'p'}}],gates:[{id:'q',from:['build'],to:[],reviewer:{kind:'human'}}]};
  const gated=applyGatePolicy(plan,'q',{requireEvidence:true,rework:{maxRounds:3,targetNodes:['build'],scopeNote:'only the report'}});
  assert.equal(gated.gates[0].requireEvidence,true);assert.deepEqual(gated.gates[0].rework,{maxRounds:3,targetNodes:['build'],scopeNote:'only the report'});
  assert.equal(validatePlan(gated,{mode:'save'}).valid,true);
  const cleared=applyGatePolicy(gated,'q',{requireEvidence:false,rework:null});
  assert.equal(cleared.gates[0].requireEvidence,undefined);assert.equal(cleared.gates[0].rework,undefined);
  assert.throws(()=>applyGatePolicy(plan,'q',{rework:{maxRounds:0}}),/positive integer/);
  assert.throws(()=>applyGatePolicy(plan,'q',{rework:{maxRounds:2,targetNodes:['ghost']}}),/reference plan nodes/);
  assert.throws(()=>applyGatePolicy(plan,'missing',{}),/Unknown gate/);
  const contracted=applyTaskContract(plan,'build',{acceptance:['a1','a2'],scope:{in:['report/'],out:['config']},verify:['check.py']});
  assert.deepEqual(contracted.nodes[0].task.contract,{acceptance:['a1','a2'],scope:{in:['report/'],out:['config']},verify:['check.py']});
  assert.equal(validatePlan(contracted,{mode:'save'}).valid,true);
  assert.equal(applyTaskContract(contracted,'build',{acceptance:[],scope:{in:[],out:[]},verify:[]}).nodes[0].task.contract,undefined);
  assert.throws(()=>applyTaskContract(plan,'ghost',{}),/Unknown node/);
  assert.equal(applyDeliveryTarget(plan,'deliverables').inputs.deliveryTarget,'deliverables');
  assert.equal(applyDeliveryTarget(applyDeliveryTarget(plan,'x'),'').inputs.deliveryTarget,undefined);
  // Original plan is never mutated.
  assert.equal(plan.gates[0].requireEvidence,undefined);assert.equal(plan.nodes[0].task.contract,undefined);
});
test('real draft component preserves UI fields and refuses old or unknown plans with recovery exits',()=>{
  const ticket=canonical(),render=t=>renderToStaticMarkup(realViews.renderDraftEditor({draft:t,language:'en',onRepair(){},onRegenerate(){}}));
  const html=render(ticket);for(const value of ['Canonical goal','Separate artifact','First line','second line','Retain requirements','local-input','Local writer'])assert.ok(html.includes(value),value);
  for(const plan of [{ticket:{goal:'Legacy goal'}},{...ticket.plan,contractVersion:9}]){const legacy=render({...ticket,plan});assert.match(legacy,/data-fleet-incompatible-ticket/);assert.match(legacy,/Incompatible/);assert.match(legacy,/Recreate in new chat/);assert.doesNotMatch(legacy,/data-fleet-draft-editor/);}
});
test('late Workspace responses cannot show another Workspace Ticket',async t=>{
 const pending=new Map();
 const h=await harness(t,{fetcher:url=>new Promise(resolve=>pending.set(new URL(url,'http://fixture').searchParams.get('workspaceId'),resolve))});
 h.open('w1');h.open('w2');
 pending.get('w2')(response(view('w2',[sampleTicket('w2','Second workspace task')])));await setImmediate();
 pending.get('w1')(response(view('w1',[sampleTicket('w1','First workspace task')])));await setImmediate();
 assert.equal(contains(h,'Second workspace task'),true);assert.equal(contains(h,'First workspace task'),false);
 assert.equal(h.requests.filter(r=>r.options.method==='POST').length,0);
});
test('a GET arriving after a committed stop cannot restore the old running state',async t=>{
 let reads=0,resolveOld;
 const h=await harness(t,{fetcher:(url,options)=>{
   if(options.method==='POST')return response({schemaVersion:1,workspaceId:'w1',action:'stop',result:sampleTicket('w1','ticket','stopped')});
   reads++;if(reads===2)return new Promise(resolve=>{resolveOld=resolve;});
   return response(view('w1',[sampleTicket('w1','ticket',reads>2?'stopped':'running')]));
 }});
 h.open();await setImmediate();h.button(h.render('dsh-fleet'),'data-open-ticket','ticket').props.onClick();
 const old=h.button(h.render('dsh-fleet'),'刷新').props.onClick();
 await h.button(h.render('dsh-fleet'),'停止任务').props.onClick();
 resolveOld(response(view('w1',[sampleTicket('w1','ticket','running')])));await old;
 assert.equal(contains(h,'已停止'),true);assert.equal(contains(h,'执行中'),false);
});
test('disabling during a pending read does not strand the re-enabled Workspace',async t=>{
 let resolveOld,reads=0;
 const h=await harness(t,{fetcher:()=>++reads===1?new Promise(resolve=>{resolveOld=resolve;}):response(view('w1',[sampleTicket('w1','Reloaded task')]))});
 h.open();await h.button(h.settings(),'data-fleet-toggle','w1').props.onClick();
 resolveOld(response(view('w1')));await setImmediate();
 await h.button(h.settings(),'data-fleet-toggle','w1').props.onClick();
 h.open();await setImmediate();
 assert.equal(reads,2);assert.equal(contains(h,'Reloaded task'),true);
});
test('valid Node IDs that match Object prototype names stay selectable and the comment composer is gone',async t=>{
 const ids=['valueOf','toString','toLocaleString'];
 const ticket=sampleTicket('w1','ticket');
  ticket.plan.nodes=ids.map(id=>({id,role:'writer',agentId:null,task:{prompt:'Work'},dependsOn:[]}));
  ticket.execution={currentConfigRevision:1,configurations:{1:{revision:1,plan:structuredClone(ticket.plan),sourceRefs:[]}},nodes:Object.fromEntries(ids.map(id=>[id,{status:'running',attempts:[],thread:[]}])),gates:{}};
 const h=await harness(t,{fetcher:()=>response(view('w1',[ticket]))});
 h.open();await setImmediate();h.button(h.render('dsh-fleet'),'data-open-ticket','ticket').props.onClick();
 const input=()=>h.all(h.render('dsh-fleet')).find(n=>n.type==='textarea');
 for(const id of ids){h.button(h.render('dsh-fleet'),'data-fleet-node',id).props.onClick();assert.equal(input(),undefined);assert.equal(h.all(h.render('dsh-fleet')).some(n=>n.props?.['data-fleet-thread']===id),true);}
 
});


function incompatibleTicket(workspaceId='w1') {
  const ticket=sampleTicket(workspaceId,'legacy-draft','draft');
  ticket.plan={ticket:{goal:'Audit Cardry and improve SEO/GEO',inputs:{url:'https://example.test'},criteria:[{evidence:'Retain structured requirements'}]},agents:[],orchestration:{},binding:{}};
  ticket.legacy={original:structuredClone(ticket.plan)};
  return ticket;
}
test('compatibility checks draft save shape rather than legacy metadata or execution readiness',()=>{
  const valid=sampleTicket('w1','valid','draft');valid.legacy={original:{old:true}};
  assert.equal(isIncompatibleDraft(valid),false);
  assert.equal(isIncompatibleDraft(incompatibleTicket()),true);
  assert.equal(isIncompatibleDraft({...incompatibleTicket(),status:'stopped'}),false);
  assert.equal(isIncompatibleDraft({...incompatibleTicket(),status:'running'}),false);
  assert.equal(isIncompatibleDraft({...valid,plan:{...valid.plan,contractVersion:999}}),true);
  assert.equal(isIncompatibleDraft({...valid,plan:{...valid.plan,criteria:[{unsupported:true}]}}),true);
});
test('recreation request retains goal and reference without mutating legacy requirements',()=>{
  const ticket=incompatibleTicket(),before=structuredClone(ticket);
  for(const language of ['zh','en']){
    const prompt=draftRecreationPrompt(ticket,language);
    assert.ok(prompt.startsWith('/fleet new Audit Cardry and improve SEO/GEO'));
    assert.ok(prompt.includes('legacy-draft (revision '+ticket.revision+')'));
    assert.match(prompt,language==='zh'?/旧草稿仅作参考，保留不变/:/Keep the previous Ticket unchanged/);
    assert.match(prompt,language==='zh'?/不启动执行/:/do not start execution/);
  }
  assert.deepEqual(ticket,before);
  delete ticket.plan.ticket.goal;
  assert.equal(draftRecreationPrompt(ticket).startsWith('/fleet new'),false);
  assert.match(draftRecreationPrompt(ticket),/请先询问我，暂不创建草稿/);
});
test('incompatible recreation opens one fresh same-workspace chat with a preserved-input request and no Ticket write',async t=>{
  const ticket=incompatibleTicket(),before=structuredClone(ticket);
  const h=await harness(t,{fetcher:()=>response(view('w1',[ticket]))});h.open();await setImmediate();
  assert.equal(h.button(h.render('dsh-fleet'),'data-open-ticket',ticket.id),undefined);
  await h.button(h.render('dsh-fleet'),'data-fleet-recreate-draft',ticket.id).props.onClick();
  assert.deepEqual(h.calls,[['panel','dsh-fleet'],['create-session',{workspaceId:'w1'}],['session','fresh-session'],['initialize-draft',{sessionId:'fresh-session'},{prompt:draftRecreationPrompt(ticket),whenDraftExists:'keep'}]]);
  assert.equal(h.requests.filter(row=>row.options.method==='POST').length,0);
  assert.deepEqual(ticket,before);
});
test('repeated recreation clicks and ordinary new-ticket clicks share the same pending creation lock',async t=>{
  let finish;const ticket=incompatibleTicket();const h=await harness(t,{fetcher:()=>response(view('w1',[ticket])),createSession:()=>new Promise(resolve=>{finish=resolve;})});h.open();await setImmediate();
  const click=h.button(h.render('dsh-fleet'),'data-fleet-recreate-draft',ticket.id).props.onClick;
  const first=click();await click();await h.button(h.render('dsh-fleet'),'新建任务').props.onClick();
  assert.equal(h.button(h.render('dsh-fleet'),'data-fleet-recreate-draft',ticket.id).props.disabled,true);
  assert.equal(h.calls.filter(row=>row[0]==='create-session').length,1);finish('fresh-session');await first;
  assert.equal(h.calls.filter(row=>row[0]==='initialize-draft').length,1);
});
test('late recreation cannot navigate or prefill after a workspace switch',async t=>{
  let finish;const ticket=incompatibleTicket();const h=await harness(t,{fetcher:url=>response(view(new URL(url,'http://fixture').searchParams.get('workspaceId'),new URL(url,'http://fixture').searchParams.get('workspaceId')==='w1'?[ticket]:[])),createSession:()=>new Promise(resolve=>{finish=resolve;})});h.open();await setImmediate();
  const first=h.button(h.render('dsh-fleet'),'data-fleet-recreate-draft',ticket.id).props.onClick();h.open('w2');finish('fresh-session');await first;
  assert.equal(h.calls.some(row=>row[0]==='session'||row[0]==='initialize-draft'),false);
});
test('a stale recreation handler cannot recreate a now-compatible draft',async t=>{
  let ticket=incompatibleTicket();const h=await harness(t,{fetcher:()=>response(view('w1',[ticket]))});h.open();await setImmediate();
  const stale=h.button(h.render('dsh-fleet'),'data-fleet-recreate-draft',ticket.id).props.onClick;
  ticket=sampleTicket('w1',ticket.id,'draft');await h.button(h.render('dsh-fleet'),'刷新').props.onClick();await stale();
  assert.equal(h.calls.some(row=>row[0]==='create-session'),false);
  assert.equal(h.requests.some(row=>row.options.method==='POST'),false);
});
test('recreation creation failure keeps the legacy draft and shows a recoverable error',async t=>{
  const ticket=incompatibleTicket();const h=await harness(t,{fetcher:()=>response(view('w1',[ticket])),createSession:async()=>{throw Error('Creation unavailable');}});h.open();await setImmediate();
  await h.button(h.render('dsh-fleet'),'data-fleet-recreate-draft',ticket.id).props.onClick();
  assert.ok(h.all(h.render('dsh-fleet')).some(node=>node.props.role==='alert'&&node.children.some(text=>typeof text==='string'&&text.includes('Creation unavailable'))));
  assert.equal(h.button(h.render('dsh-fleet'),'data-fleet-recreate-draft',ticket.id).props.disabled,false);
  assert.equal(h.calls.some(row=>row[0]==='initialize-draft'),false);
  assert.equal(ticket.status,'draft');
});
test('recreation respects a native input preservation refusal and performs no regeneration action',async t=>{
  const ticket=incompatibleTicket();const h=await harness(t,{fetcher:()=>response(view('w1',[ticket])),draftResult:'preserved'});h.open();await setImmediate();
  await h.button(h.render('dsh-fleet'),'data-fleet-recreate-draft',ticket.id).props.onClick();
  assert.ok(h.all(h.render('dsh-fleet')).some(node=>node.props.role==='alert'&&node.children.some(text=>typeof text==='string'&&text.includes('已有输入已保留'))));
  assert.equal(h.requests.some(row=>row.options.method==='POST'),false);
});

test('compatible and incompatible drafts open a cancellable confirmation and refresh after deletion',async t=>{
  const compatible=sampleTicket('w1','compatible-delete','draft');
  compatible.plan.title='Current draft title';
  const legacy={...incompatibleTicket(),title:'Legacy draft title'};
  const stopped=sampleTicket('w1','retained-stopped','stopped');
  let tickets=[compatible,legacy,stopped];
  const h=await harness(t,{sidebar:true,drafts:[compatible],fetcher:(url,options)=>{
    if(url!=='/api/fleet/action')return response(view('w1',tickets));
    const {action,ticketId}=JSON.parse(options.body);
    tickets=tickets.filter(ticket=>ticket.id!==ticketId);
    return response({schemaVersion:1,workspaceId:'w1',action,result:{deletedTicketId:ticketId}});
  }});
  const panel=()=>h.render('dsh-fleet');
  const actions=()=>h.requests.filter(row=>row.url==='/api/fleet/action');
  const viewReads=()=>h.requests.filter(row=>row.url.startsWith('/api/fleet/view')).length;
  const form=()=>h.all(panel()).find(node=>node.type==='form');
  const tab=()=>h.render('oh-my-dsh-fleet');
  const tabSelected=id=>h.all(tab()).some(node=>node.props['data-fleet-ticket-card']===id);
  h.open();await setImmediate();
  h.button(panel(),'data-fleet-tab','tickets').props.onClick();
  h.button(tab(),'data-fleet-tab','tickets').props.onClick();
  h.button(tab(),'data-open-ticket',compatible.id).props.onClick();
  assert.ok(tabSelected(compatible.id));
  assert.equal(h.button(panel(),'data-fleet-draft-delete',stopped.id),undefined);
  assert.ok(h.button(panel(),'data-open-ticket',compatible.id));
  assert.equal(h.button(panel(),'data-open-ticket',legacy.id),undefined);
  const search=()=>h.all(panel()).find(node=>node.type==='input'&&node.props.type==='search');
  search().props.onChange({target:{value:compatible.plan.title}});
  assert.ok(h.button(panel(),'data-fleet-draft-delete',compatible.id));
  assert.equal(h.button(panel(),'data-fleet-draft-delete',legacy.id),undefined);
  search().props.onChange({target:{value:''}});

  for(const [ticket,title] of [[compatible,compatible.plan.title],[legacy,legacy.title]]){
    assert.ok(h.all(panel()).some(node=>node.type==='summary'&&node.props['data-fleet-draft-menu']===ticket.id));
    const open=()=>h.button(panel(),'data-fleet-draft-delete',ticket.id).props.onClick();
    const postsBefore=actions().length;
    open();
    assert.ok(h.all(form()).some(node=>node.children.some(value=>typeof value==='string'&&value.includes(title))));
    assert.equal(actions().length,postsBefore);
    h.button(panel(),'data-fleet-draft-delete-cancel','').props.onClick();
    assert.equal(form(),undefined);
    assert.equal(actions().length,postsBefore);

    const readsBefore=viewReads();
    open();
    const submit=form().props.onSubmit;
    const first=submit({preventDefault(){}});
    assert.equal(h.button(panel(),'data-fleet-draft-delete-confirm','').props.disabled,true);
    await submit({preventDefault(){}});
    await first;
    assert.equal(actions().length,postsBefore+1);
    assert.deepEqual(JSON.parse(actions().at(-1).options.body),{workspaceId:'w1',action:'draft-delete',ticketId:ticket.id,expectedRevision:ticket.revision});
    assert.equal(viewReads(),readsBefore+1);
    assert.equal(form(),undefined);
    assert.equal(h.button(panel(),'data-fleet-draft-delete',ticket.id),undefined);
    assert.equal(tabSelected(ticket.id),false);
    assert.ok(h.button(tab(),'data-open-ticket',stopped.id),'Session Tab returns from the deleted Ticket to its list');
  }
  const pane=h.render(PANE_KEY,paneAddress(compatible.id));
  assert.ok(h.all(pane).some(node=>node.props.role==='alert'&&node.children.includes('此对话中的 Ticket 已不可用。')));
  assert.deepEqual(h.calls,[['panel','dsh-fleet']]);
});

test('draft delete keeps its error and requires renewed confirmation when the revision changes',async t=>{
  const draft=sampleTicket('w1','stale-delete','draft');
  draft.plan.title='First title';
  let current=draft;
  const h=await harness(t,{fetcher:(url)=>{
    if(url!=='/api/fleet/action')return response(view('w1',[current]));
    current={...draft,revision:draft.revision+1,plan:{...draft.plan,title:'New title'}};
    return {ok:false,status:409,json:async()=>({error:{code:'fleet/stale-revision',message:'Draft revision changed'}})};
  }});
  h.open();await setImmediate();
  const panel=()=>h.render('dsh-fleet');
  const open=()=>h.button(panel(),'data-fleet-draft-delete',draft.id).props.onClick();
  const form=()=>h.all(panel()).find(node=>node.type==='form');
  open();
  await form().props.onSubmit({preventDefault(){}});
  assert.ok(h.all(form()).some(node=>node.props.role==='alert'&&node.children.some(value=>typeof value==='string'&&value.includes('Draft revision changed'))));
  assert.ok(h.button(panel(),'data-fleet-draft-delete-confirm','').props.disabled);
  await form().props.onSubmit({preventDefault(){}});
  assert.equal(h.requests.filter(row=>row.url==='/api/fleet/action').length,1);
  h.button(panel(),'data-fleet-draft-delete-cancel','').props.onClick();
  open();
  assert.ok(h.all(form()).some(node=>node.children.some(value=>typeof value==='string'&&value.includes('New title'))));
  assert.equal(h.button(panel(),'data-fleet-draft-delete-confirm','').props.disabled,false);
});

test('draft delete reports all referencing Tickets and schedules in the confirmation',async t=>{
  const draft=sampleTicket('w1','referenced-delete','draft');
  const h=await harness(t,{fetcher:url=>url!=='/api/fleet/action'?response(view('w1',[draft])):{ok:false,status:409,json:async()=>({error:{
    code:'fleet/ticket-referenced',message:'Draft is referenced',references:[
      {kind:'ticket',id:'consumer',title:'Review backlog'},
      {kind:'series',id:'series-1',title:'Daily schedule'},
      {kind:'ticket',id:'consumer-2',title:'Another report'}
    ]
  }})}});
  h.open();await setImmediate();
  const panel=()=>h.render('dsh-fleet');
  h.button(panel(),'data-fleet-draft-delete',draft.id).props.onClick();
  const form=()=>h.all(panel()).find(node=>node.type==='form');
  await form().props.onSubmit({preventDefault(){}});
  const alert=h.all(form()).find(node=>node.props.role==='alert');
  assert.match(alert.children[0],/任务「Review backlog」\(consumer\).*计划「Daily schedule」\(series-1\).*任务「Another report」\(consumer-2\)/);
  assert.ok(h.button(panel(),'data-fleet-draft-delete',draft.id));
});

test('failed, interrupted and cancelled nodes in a running Ticket still expose the model seat; completed nodes do not',()=>{
  const ticket=evidenceTicket();
  const catalog={agents:[],orchestrations:[],modelCatalog:{default:{provider:'host',model:'default'},groups:[{id:'host',models:[{id:'default',reasoning:{efforts:[{id:'high'}]}}]}]}};
  for(const status of ['interrupted','failed','cancelled']){
    const t=structuredClone(ticket);t.execution.nodes.review.status=status;
    assert.match(dashboard(t,{nodeId:'review'},catalog),/data-fleet-model-menu-trigger="seat"/,status);
  }
  assert.doesNotMatch(dashboard(ticket,{nodeId:'build'},catalog),/data-fleet-model-menu-trigger="seat"/);
});

test('Session Tab waits for the first related Ticket and keeps it selected across refreshes',async t=>{
  const related=sampleTicket('w1','first-related','draft');
  let tickets=[{...sampleTicket('w1','unrelated'),originSessionId:'other-session'}];
  const h=await harness(t,{fetcher:()=>response(view('w1',tickets))});
  h.open();await setImmediate();
  const tab=()=>h.render('oh-my-dsh-fleet');
  const selected=id=>h.all(tab()).some(node=>node.props['data-fleet-ticket-card']===id);
  assert.equal(selected(related.id),false);
  tickets.push(related);
  await h.button(tab(),'刷新').props.onClick();
  assert.equal(selected(related.id),true,'the first render after refresh opens the related Ticket');
  tickets.push({...sampleTicket('w1','new-related','draft'),updatedAt:'2026-11-21T14:40:00Z'});
  await h.button(tab(),'刷新').props.onClick();
  assert.equal(selected(related.id),true,'a new related Ticket does not change the selection');
  assert.equal(selected('new-related'),false);
});
test('Session Tab keeps explicit navigation when the first related Ticket arrives later',async t=>{
  let tickets=[];
  const h=await harness(t,{fetcher:()=>response(view('w1',tickets))});
  h.open();await setImmediate();
  const tab=()=>h.render('oh-my-dsh-fleet');
  h.button(tab(),'data-fleet-tab','tickets').props.onClick();
  tickets=[sampleTicket('w1','new-related','draft')];
  await h.button(tab(),'刷新').props.onClick();
  assert.ok(h.button(tab(),'data-open-ticket','new-related'),'the user remains on the selected Ticket list');
  assert.equal(h.all(tab()).some(node=>node.props['data-fleet-ticket-card']==='new-related'),false);
});

const PANE_KEY='oh-my-agent-fleet/ticket-draft';
const paneAddress=id=>`dsh-resource://fleet-ticket-draft/w1/s1/${id}`;
test('with a native right sidebar the plugin registers the pinned Ticket detail pane, no header entry, and never auto-opens the pane',async t=>{
  const ticket=sampleTicket('w1','pane-ticket','draft');
  const h=await harness(t,{sidebar:true,drafts:[ticket],fetcher:()=>response(view('w1',[ticket]))});
  h.open();await setImmediate();
  assert.equal(h.elements.some(e=>e.options.name==='conversation.session.header.actions'),false,'the conversation-header draft button must be gone');
  assert.ok(h.elements.some(e=>e.options.name==='sidebar.right.pane.tab'&&e.options.key===PANE_KEY),'the explicit draft resource pane stays registered');
  assert.equal(h.calls.some(([kind])=>kind==='resource'),false,'discovering drafts must not open the side pane on its own');
  const pane=h.render(PANE_KEY,paneAddress(ticket.id));
  assert.equal(pane.props['data-fleet-surface'],'side-pane');
  assert.equal(pane.props['data-fleet-draft-artifact'],'');
  assert.ok(h.all(pane).some(node=>node.children.includes('pane-ticket')),'the pane renders the shared Ticket detail for its resource draft');
  assert.equal(h.all(pane).some(node=>node.type==='button'&&node.props['data-fleet-open-dashboard']),false,'no Dashboard jump inside the side pane');
});
test('side pane node selection stays inside the pane and a foreign-Session resource is rejected',async t=>{
  const ticket=sampleTicket('w1','pane-ticket','draft');
  ticket.plan.nodes=[{id:'A',role:'writer',agentId:null,dependsOn:[],task:{prompt:'Work A'}}];
  const h=await harness(t,{sidebar:true,drafts:[ticket],fetcher:()=>response(view('w1',[ticket]))});
  h.open();await setImmediate();
  const panelsBefore=h.calls.filter(([kind])=>kind==='panel').length;
  h.button(h.render(PANE_KEY,paneAddress(ticket.id)),'data-fleet-node','A').props.onClick();
  const pane=h.render(PANE_KEY,paneAddress(ticket.id));
  assert.equal(pane.props['data-fleet-surface'],'side-pane');
  assert.ok(h.all(pane).some(node=>node.props['data-fleet-node']==='A'&&node.props['aria-pressed']===true),'node selection is pane-local ui state');
  assert.equal(h.calls.filter(([kind])=>kind==='panel').length,panelsBefore,'node selection must not move the fullscreen panel');
  const foreign=h.render(PANE_KEY,'dsh-resource://fleet-ticket-draft/w1/other-session/pane-ticket');
  assert.ok(h.all(foreign).some(node=>node.props.role==='alert'),'a resource from another Session shows the ownership alert');
  assert.equal(h.all(foreign).some(node=>node.children.includes('pane-ticket')),false);
});