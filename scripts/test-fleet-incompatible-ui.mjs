// Isolated real-React rendering and action tests. No native Sessions or persisted Tickets.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFleetViews } from '../src/fleet-ui.js';

const validPlan={contractVersion:3,goal:'Original needs',inputs:{source:'original'},deliverables:[],criteria:[],agents:{},nodes:[],gates:[]};
const ticket=(id,plan=validPlan,extra={})=>({id,workspaceId:'workspace',originSessionId:'source-session',status:'draft',revision:7,plan:structuredClone(plan),execution:null,activity:[],...extra});
const badPlans=[{ticket:{goal:'Legacy needs',criteria:[{kind:'complex'}]}},{...validPlan,contractVersion:99},{...validPlan,criteria:[{text:'Complex criterion'}]},null,{...validPlan,nodes:[null],gates:[null]},{...validPlan,goal:{unstructured:'Original needs'}}];
const views=createFleetViews(React);
const noop=()=>{};
function options(language,tickets,ui={}) {return {language,t:key=>key,workspace:{workspaceId:'workspace',title:'Workspace',path:'G:/fixture'},enabled:true,mode:{},data:{ready:true,health:{ready:true},tickets,catalog:{agents:[],orchestrations:[]}},ui:{page:'tickets',...ui},members:[],sessionMap:{},drafts:{},creatingTicket:false,busy:false,navigate:noop,setUI:noop,openDialog:noop,act:noop,openChat:noop,recreateDraft:noop,refresh:noop,toControl:noop,returnToConversation:noop,setLanguagePreference:noop};}
function allElements(element,result=[]) {if(React.isValidElement(element)){result.push(element);React.Children.forEach(element.props.children,child=>allElements(child,result));}return result;}
const find=(tree,key,value)=>allElements(tree).find(node=>node.props[key]===value);
const html=element=>renderToStaticMarkup(element);

for(const language of ['zh','en']) {
  const copy=language==='zh'?{badge:'不兼容',action:'在新对话中重新生成',help:'发送预填请求后生成兼容草稿，原草稿保留',repair:'尝试无损修复'}:{badge:'Incompatible',action:'Recreate in new chat',help:'Send the prefilled request to generate a compatible draft; the original draft is preserved',repair:'Try lossless repair'};
  test(`${language}: invalid, unknown and missing draft plans have no list or overview detail links`,()=>{
    const drafts=badPlans.map((plan,i)=>ticket(`bad-${i}`,plan,{activity:[{id:`event-${i}`,type:'ticket-created',time:'2026-11-16T01:00:00Z'}]}));
    const before=structuredClone(drafts);
    for(const page of ['tickets','overview']) {
      const calls=[],o=options(language,drafts,{page});o.recreateDraft=value=>calls.push(value);o.navigate=()=>assert.fail('Incompatible title must not navigate');
      const tree=views.renderDashboard(o),markup=html(tree);
      for(const draft of drafts){assert.ok(!find(tree,'data-open-ticket',draft.id));assert.ok(find(tree,'data-fleet-incompatible-title',draft.id));assert.ok(find(tree,'data-fleet-incompatible-draft',draft.id));const action=find(tree,'data-fleet-recreate-draft',draft.id);assert.equal(action.props.children,copy.action);assert.equal(action.props.disabled,false);action.props.onClick();assert.equal(calls.at(-1).id,draft.id);assert.deepEqual(calls.at(-1).plan,draft.plan);}
      assert.ok(markup.includes(copy.badge));assert.ok(!markup.includes(copy.help));assert.ok(!markup.includes('data-fleet-draft-editor'));
    }
    assert.deepEqual(drafts,before,'Rendering and callbacks must not mutate drafts or persisted status');
  });
  test(`${language}: stale detail and edit dialogs show only an incompatibility notice and new-chat action`,()=>{
    for(const [index,plan] of badPlans.entries()) {
      const draft=ticket(`direct-${index}`,plan),o=options(language,[draft],{page:'ticket',ticketId:draft.id}),markup=html(views.renderDashboard(o));
      assert.ok(markup.includes(`data-fleet-incompatible-ticket="${draft.id}"`));assert.ok(markup.includes(copy.action));assert.ok(!markup.includes('data-fleet-draft-editor'));assert.ok(!markup.includes('data-fleet-thread'));assert.ok(!markup.includes('fl-workbench'));assert.ok(!markup.includes(copy.repair));
      for(const kind of ['revise','start']){const stale=html(views.renderDashboard({...o,ui:{...o.ui,dialog:{kind,ticketId:draft.id}}}));assert.ok(stale.includes('<dialog'));assert.ok(!stale.includes('data-fleet-draft-editor'));assert.ok(!stale.includes('<form'));}
      const standalone=html(views.renderDraftEditor({draft,language,recreateDraft:noop,error:'Native Session creation failed'}));assert.ok(standalone.includes(copy.action));assert.ok(!standalone.includes('data-fleet-draft-editor'));assert.ok(!standalone.includes('data-fleet-legacy-ticket'));assert.ok(standalone.includes('role="alert">Native Session creation failed'));
    }
  });
  test(`${language}: compatible drafts including repaired legacy archives still open and render the editor`,()=>{
    for(const legacy of [undefined,{original:{plan:badPlans[0]},sha256:'retained-archive'}]) {
      const draft=ticket(legacy?'repaired':'compatible',validPlan,legacy?{legacy}:{}),calls=[],o=options(language,[draft]);o.navigate=(...args)=>calls.push(args);
      const tree=views.renderDashboard(o),link=find(tree,'data-open-ticket',draft.id);assert.ok(link);assert.ok(!find(tree,'data-fleet-recreate-draft',draft.id));link.props.onClick();assert.deepEqual(calls,[['ticket',{ticketId:draft.id,nodeId:null}]]);
      assert.ok(html(views.renderDraftEditor({draft,language,catalog:{},onSave:noop,onReload:noop})).includes('data-fleet-draft-editor'));
    }
  });
  test(`${language}: running and stopped/terminal legacy Tickets retain execution history and repair behavior`,()=>{
    const frozen={...validPlan,nodes:[{id:'historical-node',agentId:null,dependsOn:[],task:{prompt:'Frozen original instruction'}}]};
    const execution={currentConfigRevision:7,configurations:{7:{plan:frozen}},nodes:{'historical-node':{status:'running',attempts:[{id:'attempt',configRevision:7,sessionId:'native-history',outputs:'Retained result'}],thread:[]}},gates:{}};
    for(const status of ['running','stop-requested','stopped','delivered','superseded']) {
      const historical=ticket(`history-${status}`,badPlans[0],{status,execution,legacy:{original:{status}}});
      const list=views.renderDashboard(options(language,[historical]));assert.ok(find(list,'data-open-ticket',historical.id));assert.ok(!find(list,'data-fleet-recreate-draft',historical.id));
      const detail=html(views.renderDashboard(options(language,[historical],{page:'ticket',ticketId:historical.id})));assert.ok(detail.includes('data-fleet-thread="historical-node"'));assert.ok(detail.includes('data-fleet-node-session="native-history"'));assert.ok(detail.includes('Retained result'));assert.ok(!detail.includes('data-fleet-incompatible-ticket'));
    }
    const stopped=ticket('stopped-repair',badPlans[0],{status:'stopped'}),repaired=[];
    const tree=views.renderDraftEditor({draft:stopped,language,onRepair:value=>repaired.push(value)});const repair=allElements(tree).find(node=>node.type==='button'&&node.props.children===copy.repair);assert.ok(repair);repair.props.onClick();assert.equal(repaired[0],stopped);assert.ok(!find(tree,'data-fleet-recreate-draft',stopped.id));
    const orphan={...stopped,originSessionId:null};assert.ok(html(views.renderDraftEditor({draft:orphan,language})).includes('/fleet repair stopped-repair 7'));
  });
  test(`${language}: related configuration and legacy replacement links cannot open incompatible drafts`,()=>{
    const incompatible=ticket('related-incompatible',badPlans[0],{execution:{currentConfigRevision:7,configurations:{7:{plan:validPlan,sourceRefs:[{kind:'orchestration',templateId:'flow'}]}},nodes:{},gates:{}}});
    const o=options(language,[incompatible],{page:'orchestration',flowId:'flow'});o.data.catalog.orchestrations=[{id:'flow',revision:1,definition:{nodes:[],gates:[]}}];
    const related=views.renderDashboard(o);assert.ok(html(related).includes(copy.action));assert.ok(find(related,'data-fleet-recreate-draft',incompatible.id));assert.ok(!find(related,'data-open-ticket',incompatible.id));
    const old=ticket('old-history',badPlans[0],{status:'superseded',supersededBy:incompatible.id}),calls=[];
    const replacement=views.renderDraftEditor({draft:old,language,tickets:[incompatible],onOpenTicket:()=>assert.fail('Blocked replacement must not navigate'),recreateDraft:value=>calls.push(value)});
    assert.ok(html(replacement).includes(copy.action));assert.ok(!find(replacement,'data-open-ticket',incompatible.id));find(replacement,'data-fleet-recreate-draft',incompatible.id).props.onClick();assert.equal(calls[0],incompatible);
  });
  test(`${language}: creation busy state disables regeneration in list, detail and standalone editor`,()=>{
    const draft=ticket('busy-draft',badPlans[0]),o=options(language,[draft]);o.creatingTicket=true;o.recreateDraft=()=>assert.fail('Busy creation must not dispatch another action');
    for(const tree of [views.renderDashboard(o),views.renderDashboard({...o,ui:{page:'ticket',ticketId:draft.id}}),views.renderDraftEditor({draft,language,creatingTicket:true,recreateDraft:o.recreateDraft})]){
      const action=find(tree,'data-fleet-recreate-draft',draft.id);assert.ok(action);assert.equal(action.props.disabled,true);action.props.onClick();assert.ok(html(tree).includes('disabled=""'));
    }
  });
}
