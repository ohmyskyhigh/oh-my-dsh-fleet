import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createFleetViews} from '../src/fleet-ui.js';
import {fleetTranslator} from '../src/fleet-locale.js';

const views=createFleetViews(React);
function reviewPage(firstStatus,secondStatus) {
  const plan={contractVersion:3,goal:'Review delivered branches',agents:{writer:{name:'Writer',profile:{instructions:'Write.'}}},
    inputs:{},criteria:[],deliverables:[],nodes:['a','b'].map(id=>({id,agentId:'writer',dependsOn:[],task:{prompt:id}})),
    gates:[{id:'check',from:['a','b'],to:[],reviewer:{kind:'human'},requireEvidence:true}]};
  const node=status=>({status,thread:[],attempts:status==='completed'?[{id:'run',status,configRevision:1,completion:{summary:'Done'}}]:[]});
  const artifact=id=>({nodeId:id,sourcePath:id+'.txt',versions:[{version:1,sha256:'a'.repeat(64),snapshotPath:'snap/'+id+'.txt'}]});
  const ticket={id:'t',workspaceId:'w',revision:1,status:'running',plan,execution:{currentConfigRevision:1,configurations:{1:{plan,sourceRefs:[]}},
    nodes:{a:node(firstStatus),b:node(secondStatus)},gates:{check:{status:'pending',reviews:[],history:[]}},artifacts:{first:artifact('a'),old:artifact('b')}}};
  return renderToStaticMarkup(views.renderDashboard({workspace:{workspaceId:'w',path:'/work'},enabled:true,language:'en',t:fleetTranslator('en'),
    mode:{},ui:{page:'ticket',ticketId:'t',gateTicketId:'t',gateId:'check'},data:{ready:true,tickets:[ticket],catalog:{}},navigate(){},setUI(){},openDialog(){},act(){},refresh(){}}));
}

test('a human can approve a mixed merge and sees artifacts from the completed source',()=>{
  const html=reviewPage('completed','skipped');
  assert.match(html,/<button(?:(?!disabled)[^>])*data-fleet-todo-approve="check"/);
  assert.match(html,/data-fleet-review-artifact="first"/);
  assert.doesNotMatch(html,/data-fleet-review-artifact="old"/);
});

test('all-skipped and incomplete merges do not solicit a review decision',()=>{
  for(const state of ['skipped','pending'])assert.doesNotMatch(reviewPage(state,'skipped'),/data-fleet-todo-approve|data-fleet-review-passed/);
});
