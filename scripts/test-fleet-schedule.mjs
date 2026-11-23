import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {FleetService} from '../src/fleet-service.js';
import {FleetCore} from '../src/fleet-core.js';
import {FleetStore,validateWorkspaceState} from '../src/fleet-store.js';
import {createDshAdapter} from '../src/fleet-dsh-adapter.js';
import {normalizePlan} from '../src/fleet-model.js';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFleetViews } from '../src/fleet-ui.js';
const first='2026-11-01T00:00:00.000Z', second='2026-11-02T00:00:00.000Z';
const timing={kind:'daily',daily:{time:'09:00',time_zone:'Asia/Shanghai'}};
const plan=()=>normalizePlan({goal:'scheduled goal',agents:{worker:{profile:{}}},nodes:[{id:'work',agentId:'worker',task:{prompt:'run'}}],gates:[{id:'final',from:['work'],to:[],reviewer:{kind:'human'}}]});
async function fixture(t,p=plan()) {
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'fleet-schedule-')),services=[];
 const calls={create:[],edit:[]}, state={sessions:0,catalog:{groups:[{id:'p',models:[{id:'m'}]}]}};
 const adapter={async create(){return {sessionId:`execution-${++state.sessions}`};},async submit(){},async cancel(){},async message(){},async inspect(){return {status:'completed',output:'done'};},async modelCatalog(){if(state.catalogError) throw new Error('connection lost');return state.catalog;},
  async scheduleCreate(request){calls.create.push(request);state.entry={id:'schedule',target:{sessionId:'target'},scheduledAt:first,status:'active',...state.override};return structuredClone(state.entry);},
  async scheduleView(){return structuredClone(state.entry);},async scheduleEdit(req){calls.edit.push(req);if(req.action==='delete')return {deleted:true};if(state.entry.code)return state.entry;state.entry.status=req.patch.active?'active':'paused';return structuredClone(state.entry);}};
 const workspace=path.join(temp,'workspace');
 const open=async()=>{const s=await FleetService.open({rootPath:path.join(temp,'root'),workspacePaths:{w:workspace},adapter,autoStart:false});services.push(s);return s;};
 const s=await open();t.after(async()=>{for(const svc of services)await svc.close();assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert(path.basename(temp).startsWith('fleet-schedule-'));assert(!(await fs.lstat(temp)).isSymbolicLink());await fs.rm(temp,{recursive:true,force:true});});
 const draft=await s.saveDraftTicket('w',{id:'source',sessionId:'origin',plan:p});
 return {s,open,state,calls,adapter,draft,workspace,enable:()=>s.seriesCreate('w',{sourceTicketId:'source',name:'Daily',timing}),read:async()=>(await s.readSeries('w'))[0],deliver:at=>state.entry.lastDelivery={scheduledAt:at,deliveredAt:at,targetSessionId:'target'}};
}
const chatSchedule = (ticket, fields = {}) => ({
 ticketId:ticket.id, expectedRevision:ticket.revision, name:'Chat schedule', kind:'daily', time:'09:30', timeZone:'Asia/Shanghai', ...fields,
});
const chatRules = [
 [{kind:'at',date:'2035-01-08'}, {kind:'at',at:{date:'2035-01-08',time:'09:30:00',time_zone:'Asia/Shanghai'}}],
 [{kind:'daily'}, {kind:'daily',daily:{time:'09:30:00',time_zone:'Asia/Shanghai'}}],
 [{kind:'weekly',weekdays:[5,1,5]}, {kind:'weekly',weekly:{time:'09:30:00',time_zone:'Asia/Shanghai',weekdays:[1,5]}}],
];
for (const [rule, expectedTiming] of chatRules) test(`Chat ${rule.kind} scheduling persists the receipt and audit before any execution`, async t => {
 const f = await fixture(t);
 const args = chatSchedule(f.draft, rule);
 const receipt = await f.s.agentSchedule('w', 'origin', args);
 assert.deepEqual(receipt, {seriesId:receipt.seriesId,scheduleId:'schedule',sourceTicketId:f.draft.id,revision:1,status:'active',timing:expectedTiming,scheduledAt:first});
 assert.ok(receipt.seriesId);
 assert.equal(f.calls.create.length, 1);
 assert.deepEqual(f.calls.create[0].timing, expectedTiming);
 assert.deepEqual(f.calls.create[0].target, {kind:'new_once',create:{cwd:f.workspace}});
 const source = await f.s.read('w', f.draft.id);
 assert.equal(source.revision, f.draft.revision + 1);
 assert.equal(source.status, 'draft');
 assert.equal(source.execution, null);
 assert.deepEqual(source.plan, f.draft.plan);
 const event = source.activity.find(a => a.type === 'series-created');
 assert.deepEqual(event.actor, {kind:'agent',userId:'origin',via:'user-request'});
 assert.deepEqual(event.detail, {seriesId:receipt.seriesId,scheduleId:receipt.scheduleId,sourceRevision:f.draft.revision});
 const stored = await f.read();
 assert.deepEqual(stored.plan, f.draft.plan);
 assert.deepEqual(stored.occurrences, []);
 assert.equal(f.state.sessions, 0);
 await f.s.close();
 const reopened = await f.open();
 assert.deepEqual(await reopened.agentSchedule('w', 'origin', args), receipt, 'replay with the original revision returns the persisted receipt');
 assert.equal(f.calls.create.length, 1);
 assert.deepEqual(await reopened.read('w', f.draft.id), source, 'replay must not append another activity event');
 assert.equal((await reopened.readSeries('w')).length, 1);
 f.deliver(first);
 await reopened.tick();
 const [series] = await reopened.readSeries('w');
 const [occurrence] = series.occurrences;
 const started = await reopened.read('w', occurrence.ticketId);
 assert.notEqual(started.id, f.draft.id);
 assert.deepEqual(started.plan, f.draft.plan);
 assert.deepEqual(started.activity.find(a => a.type === 'ticket-started').actor, {kind:'system',via:'schedule',scheduleId:'schedule',occurrenceAt:first});
 assert.equal((await reopened.read('w', f.draft.id)).status, 'draft');
});

test('Chat scheduling rejects foreign, stale, abandoned and invalid requests before creating a host task', async t => {
 const f = await fixture(t);
 const args = chatSchedule(f.draft);
 await assert.rejects(f.s.agentSchedule('w', 'other', args), /conversation|session/i);
 await assert.rejects(f.s.agentSchedule('w', 'origin', {...args, expectedRevision:args.expectedRevision + 1}), {code:'stale-revision'});
 for (const invalid of [
   {kind:'every'}, {time:'27:30'}, {timeZone:'Invalid/Zone'}, {timeZone:'+08:00'}, {kind:'at'}, {kind:'at',date:'2035-02-30'},
   {kind:'weekly'}, {kind:'weekly',weekdays:[]}, {kind:'weekly',weekdays:[0,8]}, {date:'2035-01-08'}, {weekdays:[1]},
 ]) {
   await assert.rejects(f.s.agentSchedule('w', 'origin', {...args, ...invalid}), {code:'invalid-input'});
 }
 const abandoned = await f.s.human('w','user','abandonTicket',[f.draft.id,f.draft.revision]);
 await assert.rejects(f.s.agentSchedule('w', 'origin', chatSchedule(abandoned)), /abandoned/i);
 assert.equal(f.calls.create.length, 0);
 assert.deepEqual(await f.s.readSeries('w'), []);
});

test('Chat scheduling validates runnable plans and live models before creating a host task', async t => {
 const selection = {provider:'p',model:'m'};
 const configured = plan();
 configured.agents.worker.profile.modelSelection = selection;
 const f = await fixture(t, configured);
 const incomplete = await f.s.saveDraftTicket('w',{sessionId:'origin',plan:normalizePlan({goal:'Still drafting'})});
 await assert.rejects(f.s.agentSchedule('w', 'origin', chatSchedule(incomplete)));
 f.state.catalog.groups[0].models = [];
 await assert.rejects(f.s.agentSchedule('w', 'origin', chatSchedule(f.draft)), {code:'unsupported-profile'});
 assert.equal(f.calls.create.length, 0);
 assert.deepEqual(await f.s.readSeries('w'), []);
});

test('Chat scheduling removes the host task if the source revision changes before Fleet commits', async t => {
 const f = await fixture(t);
 const concurrent = await f.open();
 const create = f.adapter.scheduleCreate;
 f.adapter.scheduleCreate = async input => {
   const entry = await create(input);
   await concurrent.saveDraftTicket('w', {ticketId:f.draft.id,sessionId:'origin',expectedRevision:f.draft.revision,plan:{...f.draft.plan,goal:'Later user edit'}});
   return entry;
 };
 await assert.rejects(f.s.agentSchedule('w', 'origin', chatSchedule(f.draft)), {code:'stale-revision'});
 assert.deepEqual(f.calls.edit, [{id:'schedule',action:'delete'}]);
 assert.deepEqual(await f.s.readSeries('w'), []);
 const source = await f.s.read('w', f.draft.id);
 assert.equal(source.plan.goal, 'Later user edit');
 assert.equal(source.activity.some(a => a.type === 'series-created'), false);
});

test('Concurrent identical Chat requests keep one Fleet series and one host schedule', {timeout:5000}, async t => {
 const f = await fixture(t);
 const competing = await f.open();
 let releaseCreates;
 const bothCreated = new Promise(resolve => { releaseCreates = resolve; });
 const hostIds = [];
 f.adapter.scheduleCreate = async () => {
   const id = `schedule-${hostIds.length + 1}`;
   hostIds.push(id);
   if (hostIds.length === 2) releaseCreates();
   await bothCreated;
   return {id,target:{sessionId:`${id}-target`},scheduledAt:first,status:'active'};
 };
 const args = chatSchedule(f.draft, {kind:'weekly',weekdays:[5,1,5]});
 const [firstReceipt, secondReceipt] = await Promise.all([
   f.s.agentSchedule('w', 'origin', args),
   competing.agentSchedule('w', 'origin', {...args,name:` ${args.name} `,weekdays:[1,5]}),
 ]);
 assert.deepEqual(firstReceipt, secondReceipt);
 assert.deepEqual(f.calls.edit, [{id:hostIds.find(id => id !== firstReceipt.scheduleId),action:'delete'}]);
 const [series, source] = await Promise.all([f.s.readSeries('w'),f.s.read('w', f.draft.id)]);
 assert.equal(series.length, 1);
 assert.equal(series[0].scheduleId, firstReceipt.scheduleId);
 assert.equal(source.activity.filter(a => a.type === 'series-created').length, 1);
});

test('template schedule atomically commits its source draft and preserves old template revisions', async t => {
 const f=await fixture(t), workspace='empty';
 await f.s.registerWorkspace(workspace,path.join(path.dirname(f.workspace),'empty'));
 const human=(method,...args)=>f.s.human(workspace,'user',method,args);
 const profile={instructions:'old instructions',modelSelection:{provider:'p',model:'m'}};
 await human('saveTemplate',{id:'writer',kind:'agent',content:{profile}});
 await human('saveTemplate',{id:'flow',kind:'orchestration',content:{nodes:[{id:'job',agentId:'writer',task:{prompt:'original'}}],gates:[]}});
 const create=()=>f.s.seriesCreate(workspace,{name:'template run',timing,templateId:'flow',overrides:{goal:'from template'},assignments:{}});
 f.state.catalog.groups[0].models=[];
 await assert.rejects(create(),{code:'unsupported-profile'}); assert.deepEqual(await f.s.read(workspace),[]); assert.equal(f.calls.create.length,0);
 f.state.catalog.groups[0].models=[{id:'m'}]; const realCreate=f.adapter.scheduleCreate;
 f.adapter.scheduleCreate=async()=>{throw new Error('Host create failed');};
 await assert.rejects(create(),/Host create failed/); assert.deepEqual(await f.s.read(workspace),[]);
 f.adapter.scheduleCreate=realCreate; const series=await create();
 assert.equal((await f.s.read(workspace,series.sourceTicketId)).originSessionId,null); assert.equal(series.sourceTemplateId,'flow');
 await human('replaceRootAgent','writer',{instructions:'new instructions'});
 await human('replaceRootOrchestration','flow',{nodes:[{id:'changed',task:{prompt:'changed'}}],gates:[]});
 f.deliver(first); await f.s.tick(); const [current]=await f.s.readSeries(workspace);
 const ticket=await f.s.read(workspace,current.occurrences[0].ticketId);
 assert.equal(ticket.plan.nodes[0].id,'job'); assert.deepEqual(ticket.plan.agents.writer.profile,profile);
 const refs=ticket.execution.configurations[ticket.execution.currentConfigRevision].sourceRefs;
 assert.deepEqual(refs.find(r=>r.kind==='agent').content.profile,profile); assert(refs.every(r=>r.templateRevision===1));
});
test('retired v2 series remains readable and cannot start another occurrence', () => {
 const core = new FleetCore();
 const series = core.createSeries('w', {name:'Daily', plan:plan(), scheduleId:'schedule', targetSessionId:'target', timing});
 const state = core.exportState();
 state.workspaces[0].series[0].plan.contractVersion = 2;
 const reopened = FleetCore.fromState(state);
 assert.equal(reopened.readSeries('w', series.id).plan.contractVersion, 2);
 assert.throws(() => reopened.recordOccurrenceAndStart('w', series.id, {occurrenceAt:first}), {code:'unsupported-contract'});
 assert.equal(reopened.readSeries('w', series.id).occurrences.length, 0);
});
test('one-shot calendar, next run and rule summary follow host edits while receipts retain their actual start', t => {
  const local = (day,hour,minute=0) => new Date(2030,0,day,hour,minute);
  t.mock.timers.enable({apis:['Date'],now:local(7,9).getTime()}); // Monday
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const saved = {kind:'at',at:{date:'2030-01-08',time:'11:00:00',time_zone:zone}};
  const base = {id:'once',name:'One shot',status:'active',timing:saved,occurrences:[]};
  const views = createFleetViews(React);
  function render(series) {
    return renderToStaticMarkup(views.renderDashboard({language:'en',t:key=>key,workspace:{title:'Test'},enabled:true,ui:{page:'schedules'},mode:{},data:{ready:true,tickets:[],series:{items:[series]}}}));
  }
  for (const [hostTime,expected] of [
    [local(8,17,10).toISOString(),local(8,17,10)],
    [local(9,10,30).toISOString(),local(9,10,30)],
    [undefined,local(8,11)], ['invalid date',local(8,11)], ['2030-02-30T12:00:00Z',local(8,11)]
  ]) {
    const html=render({...base,host:{timing:{kind:'at'},scheduledAt:hostTime}});
    const day=`2030-01-${String(expected.getDate()).padStart(2,'0')}`;
    const column=html.split(`data-fleet-cal-col="${day}"`)[1].split('</section>')[0];
    assert.equal(html.split('data-fleet-cal-event="once"').length-1,1);
    assert.ok(column.includes('data-fleet-cal-event="once"'));
    const clock = `${String(expected.getHours()).padStart(2,'0')}:${String(expected.getMinutes()).padStart(2,'0')}`;
    assert.ok(column.includes(clock));
    const formatted=new Intl.DateTimeFormat('en',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:zone}).format(expected);
    assert.ok(html.includes(`data-fleet-series-timing="once">Once · ${formatted}<`));
    assert.ok(html.includes(`data-fleet-series-next="once">${formatted}<`));
  }
  const elapsed=render({...base,host:{scheduledAt:local(6,14).toISOString()}});
  assert.ok(!elapsed.includes('data-fleet-cal-event="once"'),'a past host instant supersedes the future creation time');
  const absolute=render({...base,timing:{kind:'at',at:local(9,13).toISOString()}});
  assert.ok(absolute.split('data-fleet-cal-col="2030-01-09"')[1].split('</section>')[0].includes('13:00'));
  const after=render({...base,timing:{kind:'after',after_seconds:60},host:{scheduledAt:'bad'}});
  assert.ok(!after.includes('data-fleet-cal-event="once"'));
  assert.ok(after.includes('data-fleet-series-next="once">—<'));
  for (const status of ['ended','orphaned']) {
    const html=render({...base,status,host:{scheduledAt:local(9,10).toISOString()},occurrences:[{status:'started',occurrenceAt:local(7,7).toISOString(),createdAt:local(7,8,37).toISOString(),ticketId:'started'}]});
    assert.equal(html.split('data-fleet-cal-event="once"').length-1,1);
    assert.ok(html.split('data-fleet-cal-col="2030-01-07"')[1].split('</section>')[0].includes('08:37'));
  }
});

test('core requires the host timing at creation and reload', () => {
 const core=new FleetCore(), base={name:'Daily',plan:plan(),scheduleId:'schedule',targetSessionId:'target'};
 assert.throws(()=>core.createSeries('w',{...base}),{code:'invalid-input'});
 assert.throws(()=>core.createSeries('w',{...base,timing:{kind:'hourly'}}),{code:'invalid-input'});
 assert.deepEqual(core.listSeries('w'),[]);
 core.createSeries('w',{...base,timing});
 const state=core.exportState(); delete state.workspaces[0].series[0].timing;
 assert.throws(()=>FleetCore.fromState(state),{code:'invalid-state'});
});
test('incomplete or unavailable configuration fails before host creation',async t=>{const f=await fixture(t,{goal:'incomplete'});await assert.rejects(f.enable(),{code:'incomplete-plan'});assert.equal(f.calls.create.length,0);const p=plan();p.nodes[0].modelSelection={provider:'missing',model:'absent'};await f.s.saveDraftTicket('w',{ticketId:'source',expectedRevision:1,plan:p});await assert.rejects(f.enable(),{code:'unsupported-profile'});assert.equal(f.calls.create.length,0);});
test('failure binding a host task compensates its creation',async t=>{const f=await fixture(t);f.state.override={target:{}};await assert.rejects(f.enable(),{code:'invalid-input'});assert.deepEqual(f.calls.edit,[{id:'schedule',action:'delete'}]);assert.deepEqual(await f.s.readSeries('w'),[]);assert(f.s.health.ready);});
test('new receipts start independently, atomically and once across competing services',async t=>{const f=await fixture(t),series=await f.enable(),other=await f.open();assert.deepEqual(f.calls.create[0].target,{kind:'new_once',create:{cwd:f.workspace}});f.deliver(first);await Promise.all([f.s.tick(),other.tick()]);await f.s.tick();await f.s.tick();const firstId=(await f.read()).occurrences[0].ticketId;const a=await f.s.read('w',firstId);assert.equal(a.status,'running');assert.equal(a.execution.nodes.work.status,'completed');assert.equal(a.execution.gates.final.status,'pending');assert.equal(a.originSessionId,'target');assert.equal(a.activity[0].detail.seriesId,series.id);assert.deepEqual(a.activity.find(e=>e.type==='ticket-started').actor,{kind:'system',via:'schedule',scheduleId:'schedule',occurrenceAt:first});f.deliver(second);await f.s.tick();const o=(await f.read()).occurrences;assert.deepEqual(o.map(x=>x.occurrenceAt),[first,second]);assert.notEqual(o[0].ticketId,o[1].ticketId);assert.equal((await f.s.read('w',o[1].ticketId)).status,'running');assert.equal((await f.s.read('w',firstId)).status,'running');});
test('host echoes sync changes and unchanged observations do not publish',async t=>{const f=await fixture(t),s=await f.enable();f.state.entry.status='paused';await f.s.tick();assert.equal((await f.read()).status,'paused');const pointer=path.join(f.workspace,'.fleet/current.json'),before=await fs.readFile(pointer,'utf8');await f.s.tick();assert.equal(await fs.readFile(pointer,'utf8'),before);f.state.entry.status='active';await f.s.tick();assert.equal((await f.read()).status,'active');f.state.entry={code:'schedule_not_found'};await f.s.tick();assert.equal((await f.read()).status,'orphaned');await assert.rejects(f.s.seriesResume('w',s.id),{code:'unknown-series'});assert.equal((await f.s.seriesDelete('w',s.id)).status,'ended');});
test('temporary catalog outage retries and a removed model records a failed occurrence and pauses host',async t=>{const p=plan();p.nodes[0].modelSelection={provider:'p',model:'m'};const f=await fixture(t,p);await f.enable();f.deliver(first);f.state.catalogError=true;await f.s.tick();assert.equal((await f.read()).occurrences.length,0);f.state.catalogError=false;f.state.catalog={groups:[]};await f.s.tick();const s=await f.read();assert.equal(s.status,'paused');assert.equal(s.occurrences[0].status,'failed');assert.equal(s.occurrences[0].ticketId,null);assert.match(s.occurrences[0].error,/p\/m/);assert.equal(f.calls.edit.at(-1).patch.active,false);assert.equal((await f.s.read('w')).length,1);});
test('scope enforcement follows the latest host rule after changes in both directions', async t => {
  const f=await fixture(t);
  await f.enable();
  Object.assign(f.state.entry,{kind:'at',scheduledAt:second});
  await f.s.tick();
  const edit=await f.s.saveDraftTicket('w',{ticketId:'source',expectedRevision:1,plan:{...f.draft.plan,title:'one shot'}});
  Object.assign(f.state.entry,{kind:'weekly',weekdays:[2],time:'18:45:00',timeZone:'UTC'});
  await f.s.tick();
  await assert.rejects(f.s.saveDraftTicket('w',{ticketId:'source',expectedRevision:edit.revision,plan:edit.plan}),{code:'scope-required'});
});
test('a failed host pause is retried after reopening without consuming or restarting the failed occurrence', async t => {
 const p=plan(); p.nodes[0].modelSelection={provider:'p',model:'m'};
 const f=await fixture(t,p); await f.enable(); f.deliver(first); f.state.catalog.groups=[];
 const edit=f.adapter.scheduleEdit;
 f.adapter.scheduleEdit=async()=>{throw new Error('connection reset');};
 await f.s.tick(); assert.equal((await f.read()).status,'paused'); assert.equal(f.state.entry.status,'active');
 f.adapter.scheduleEdit=edit; const other=await f.open(); await other.tick();
 assert.equal(f.state.entry.status,'paused'); const current=await f.read(); assert.equal(current.host.status,'paused'); assert.equal(current.occurrences.length,1);
});
test('scoped save promotes only current changes and rolls both revisions back on conflict',async t=>{const f=await fixture(t),series=await f.enable();const save=arg=>f.s.saveDraftWithScope('w',{ticketId:'source',sessionId:'origin',...arg});await assert.rejects(save({expectedRevision:1,plan:f.draft.plan}),{code:'scope-required'});const edited=await save({scope:'ticket',expectedRevision:1,plan:{...f.draft.plan,title:'private'}});assert.deepEqual((await f.read()).plan,series.plan);const result=await save({scope:'series',expectedRevision:edited.revision,expectedSeriesRevision:1,plan:{...edited.plan,goal:'shared'}});assert.equal(result.series.plan.goal,'shared');assert.equal(result.series.plan.title,undefined);await assert.rejects(save({scope:'series',expectedRevision:result.ticket.revision,expectedSeriesRevision:1,plan:{...result.ticket.plan,goal:'stale'}}),{code:'stale-revision'});assert.deepEqual(await f.s.read('w','source'),result.ticket);assert.deepEqual(await f.read(),result.series);});
test('store round-trips series and rejects invalid shape and repeated occurrence identities',async t=>{const f=await fixture(t);await f.enable();f.deliver(first);await f.s.tick();const disk=await FleetStore.read({dir:path.join(f.workspace,'.fleet'),kind:'workspace'});assert.deepEqual(disk.series,[await f.read()]);for(const breakState of [s=>s.revision=0,s=>s.workspaceId='other',s=>s.status='unknown',s=>s.plan.goal='',s=>s.occurrences.push(s.occurrences[0])]){const broken=structuredClone(disk);breakState(broken.series[0]);assert.throws(()=>validateWorkspaceState(broken));const state=new FleetCore().exportState();state.workspaces=[broken];assert.throws(()=>FleetCore.fromState(state),{code:'invalid-state'});}});
test('ended host reconciles every retained paginated receipt after restart before closing',async t=>{const f=await fixture(t);await f.enable();f.deliver(second);await f.s.tick();let pages=0;f.adapter.scheduleHistory=async({before})=>{pages++;return before?{records:[{scheduledAt:first}]}:{records:[{scheduledAt:second}],nextBefore:'cursor'};};const other=await f.open();f.state.entry.status='ended';await other.tick();assert.equal(pages,2);const s=await f.read();assert.equal(s.status,'ended');assert.deepEqual(s.occurrences.map(o=>o.occurrenceAt).sort(),[first,second]);});
test('optional schedule adapter returns detached JSON, preserves transient errors and diagnoses inputs',async()=>{const absent=createDshAdapter({get:()=>null});await assert.rejects(absent.scheduleCreate({}),{code:'unsupported-profile'});const result={status:'active',target:{sessionId:'t'}};const adapter=createDshAdapter({get:()=>({view:async()=>result,create(){throw Object.assign(new Error('Rule invalid'),{code:'invalid_rule'});},edit(){throw Object.assign(new Error('Read failure'),{code:'EIO'});}})});(await adapter.scheduleView({id:'s'})).target.sessionId='other';assert.equal(result.target.sessionId,'t');await assert.rejects(adapter.scheduleCreate({}),{code:'invalid-input'});await assert.rejects(adapter.scheduleEdit({}),{code:'EIO'});});
