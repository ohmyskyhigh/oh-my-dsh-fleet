import test from 'node:test';
import assert from 'node:assert/strict';
import {FleetCore} from '../packages/fleet-shell/src/fleet-core.js';
function fixture(){
 const c=new FleetCore(), h=c.human('w','user');
 h.saveTemplate({id:'writer',kind:'agent',name:'Writer',content:{profile:{instructions:'original'}}});
 h.saveTemplate({id:'flow',kind:'orchestration',content:{nodes:[{id:'a',task:{prompt:'a'}},{id:'b',task:{prompt:'b'}}],gates:[]}});
 return {c,h};
}
const input={templateId:'flow',overrides:{goal:'run'},assignments:{a:'writer',b:'writer'}};
test('instantiation lists every missing node and does not create a draft',()=>{const {c,h}=fixture();assert.throws(()=>h.instantiateTemplate({...input,assignments:{}}),e=>e.code==='incomplete-plan'&&e.message.includes('a, b'));assert.equal(c.listTickets('w').length,0);});
test('instantiation copies profiles and records exact provenance',()=>{const {c,h}=fixture(),t=h.instantiateTemplate(input);assert.deepEqual(t.plan.agents.writer,{name:'Writer',profile:{instructions:'original'}});assert.deepEqual(t.activity.filter(a=>a.type==='template-applied').map(a=>(({kind,templateId,templateRevision,localId,nodeIds})=>({kind,templateId,templateRevision,...(localId?{localId}:{nodeIds})}))(a.detail)),[{kind:'orchestration',templateId:'flow',templateRevision:1,nodeIds:['a','b']},{kind:'agent',templateId:'writer',templateRevision:1,localId:'writer'}]);h.replaceRootAgent('writer',{instructions:'changed'});assert.equal(c.readTicket('w',t.id).plan.agents.writer.profile.instructions,'original');});
test('historical orchestration revisions and existing Root assignments are copied',()=>{const {c,h}=fixture();h.replaceRootOrchestration('flow',{nodes:[{id:'new',task:{prompt:'new'}}],gates:[]});const t=h.instantiateTemplate({...input,templateRevision:1});assert.deepEqual(t.plan.nodes.map(n=>n.id),['a','b']);h.replaceRootOrchestration('flow',{nodes:[{id:'a',agentId:'writer',task:{prompt:'a'}}],gates:[]});assert.equal(h.instantiateTemplate({templateId:'flow',overrides:{goal:'existing'}}).plan.nodes[0].agentId,'writer');});