import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetCore } from '../src/fleet-core.js';
import { normalizePlan } from '../src/fleet-model.js';
const plan = () => normalizePlan({goal:'Series',deliverables:['report.md'],criteria:['base'],agents:{writer:{profile:{instructions:'Write'}},reviewer:{profile:{instructions:'Review'}}},nodes:[{id:'write',agentId:'writer',dependsOn:[],task:{prompt:'Write'},modelSelection:{provider:'p',model:'base'}},{id:'review',agentId:'reviewer',dependsOn:['write'],task:{prompt:'Review'}}],gates:[{id:'check',from:['write'],to:['review'],reviewer:{kind:'agent',nodeId:'review'}}]});
function fixture(seriesPlan=plan(),ticketPlan=structuredClone(seriesPlan)){
 const core=new FleetCore();core.saveDraftTicket('w',{id:'source',plan:structuredClone(seriesPlan)});core.createSeries('w',{id:'series',name:'Weekly',plan:seriesPlan,sourceTicketId:'source',scheduleId:'native-1',targetSessionId:'series-session',timing:{kind:'weekly',weekly:{time:'09:00',time_zone:'Asia/Shanghai',weekdays:[1]}}});
 const before=core.saveDraftTicket('w',{id:'occurrence',sessionId:'series-session',plan:ticketPlan});
 return {core,before:before.plan,apply(after){return core.applySeriesChanges('w','series',{before:this.before,after:normalizePlan(after),expectedRevision:core.readSeries('w','series').revision}).plan;}};
}
test('same node model edit preserves a ticket-only prompt exception and series-only metadata',()=>{
 const base=plan();base.nodes[0].task.metadata={seriesOnly:true};const local=structuredClone(base);local.nodes[0].task.prompt='This occurrence only';const f=fixture(base,local);const after=structuredClone(local);after.nodes[0].modelSelection.model='new';const result=f.apply(after);
 assert.equal(result.nodes[0].modelSelection.model,'new');assert.equal(result.nodes[0].task.prompt,'Write');assert.equal(result.nodes[0].task.metadata.seriesOnly,true);
});
test('unrelated local node is not added to the series when another model changes',()=>{
 const base=plan(),local=structuredClone(base);local.nodes.push({id:'local-only',agentId:'writer',dependsOn:[],task:{prompt:'Local exception'}});const f=fixture(base,local);const after=structuredClone(local);after.nodes[0].modelSelection.model='new';const result=f.apply(after);assert.equal(result.nodes.length,2);assert.equal(result.nodes.some(n=>n.id==='local-only'),false);
});
test('new shared node keeps its dependency position without absorbing local-only nodes',()=>{
 const base=plan(),local=structuredClone(base);local.nodes.push({id:'local-only',agentId:'writer',dependsOn:[],task:{prompt:'Local'}});const f=fixture(base,local);const after=structuredClone(local);after.nodes.splice(1,0,{id:'new-shared',agentId:'writer',dependsOn:['write'],task:{prompt:'New shared stage'}});after.nodes[2].dependsOn.push('new-shared');const result=f.apply(after);assert.deepEqual(result.nodes.map(n=>n.id),['write','new-shared','review']);assert.deepEqual(result.nodes[2].dependsOn,['write','new-shared']);
});
test('ticket-only criteria and deliverable exceptions do not leak through an unrelated edit',()=>{
 const base=plan(),local=structuredClone(base);local.criteria.push('local criterion');local.deliverables[0]='local.md';const f=fixture(base,local);const after=structuredClone(local);after.goal='New shared goal';const result=f.apply(after);assert.equal(result.goal,'New shared goal');assert.deepEqual(result.criteria,['base']);assert.deepEqual(result.deliverables,['report.md']);
});
test('a changed positional list propagates each changed item, not unrelated local exceptions',()=>{
 const base=plan();base.criteria=['a','b'];const local=structuredClone(base);local.criteria[1]='local b';const f=fixture(base,local);const after=structuredClone(local);after.criteria[0]='shared a';const result=f.apply(after);assert.deepEqual(result.criteria,['shared a','b']);
});
test('conflicting membership with local exceptions asks for an explicit series edit',()=>{
 const base=plan();base.criteria=['a','b'];const local=structuredClone(base);local.criteria[1]='local b';const f=fixture(base,local);const after=structuredClone(local);after.criteria.push('new');assert.throws(()=>f.apply(after),e=>e.code==='state-conflict');
});
test('a new node conflicting with a different series-only node is rejected atomically',()=>{
 const base=plan();base.nodes.push({id:'shared-id',agentId:'writer',dependsOn:[],task:{prompt:'Series variant'}});const local=plan(),f=fixture(base,local);const after=structuredClone(local);after.nodes.push({id:'shared-id',agentId:'writer',dependsOn:[],task:{prompt:'New local variant'}});assert.throws(()=>f.apply(after),e=>e.code==='state-conflict');assert.equal(f.core.readSeries('w','series').revision,1);
});