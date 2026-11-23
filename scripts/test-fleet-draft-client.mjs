import test from 'node:test';
import assert from 'node:assert/strict';
import {createFleetDraftClient} from '../src/fleet-draft-client.js';

const scope={workspaceId:'w1',sessionId:'s1'};
const draft=(id='d1',revision=1,extra={})=>({id,workspaceId:scope.workspaceId,originSessionId:scope.sessionId,revision,status:'draft',plan:{contractVersion:3,goal:`Goal ${revision}`,inputs:{},deliverables:[],criteria:[],agents:{},nodes:[],gates:[]},execution:null,activity:[],createdAt:'2026-11-11T01:00:00Z',updatedAt:'2026-11-11T01:00:00Z',...extra});
const envelope=(drafts,selectedDraft=drafts.at(-1))=>({schemaVersion:1,workspaceId:'w1',drafts,selectedDraft});
function fixture(fetcher) {
  let current=scope;
  const calls=[];
  const client=createFleetDraftClient({decode:async value=>value,fetcher:async(url,options)=>{calls.push({url,options});return fetcher(url,options);},getScope:()=>current});
  return {client,calls,select:value=>{current=value;}};
}

test('polling only refreshes records; it never opens a resource for new drafts, revisions or session revisits',async()=>{
  let drafts=[draft('older',1,{createdAt:'2026-11-10'}),draft()];
  const f=fixture(()=>envelope(drafts));
  await f.client.poll();await f.client.poll();
  assert.equal(f.client.record({...scope,draftId:'d1'}).draft.revision,1);
  drafts=[draft('d1',2)];await f.client.poll();
  assert.equal(f.client.record({...scope,draftId:'d1'}).draft.revision,2);
  const before=f.calls.length;
  f.select(null);await f.client.poll();assert.equal(f.calls.length,before,'no active scope means no request');
  f.select(scope);await f.client.poll();
  drafts.push(draft('d2',1,{createdAt:'2026-11-12'}));await f.client.poll();
  assert.equal(f.client.latest(scope).id,'d2');
  assert.match(f.calls[0].url,/workspaceId=w1&sessionId=s1/);
  assert.equal(f.calls.every(call=>(call.options.method??'GET')==='GET'),true,'the draft client never writes or navigates on its own');
});

test('late responses only update records and cannot navigate another active Session',async()=>{
  let resolve;const f=fixture(()=>new Promise(done=>{resolve=done;}));
  const read=f.client.poll();f.select({workspaceId:'w2',sessionId:'s2'});resolve(envelope([draft()]));await read;
  assert.equal(f.client.record({...scope,draftId:'d1'}).draft.id,'d1');
});

test('polling publishes remote revision while dirty editor saves still use its original CAS revision',async()=>{
  let remote=draft();const f=fixture((url,options)=>{
    if(options.method==='POST')throw Error('Draft revision conflict');
    return envelope([remote]);
  });
  const address={...scope,draftId:'d1'};
  await f.client.poll();f.client.setDirty(address,true);remote=draft('d1',2);await f.client.poll();
  assert.equal(f.client.record(address).draft.revision,2);
  assert.equal(await f.client.save(address,{...draft().plan,goal:'Unsaved'},draft()),null);
  assert.equal(f.client.record(address).dirty,true);assert.match(f.client.record(address).error.message,/conflict/);
  const args=JSON.parse(f.calls.at(-1).options.body);assert.equal(args.expectedRevision,1);assert.equal(args.sessionId,'s1');
  await f.client.reload(address);assert.equal(f.client.record(address).draft.revision,2);assert.equal(f.client.record(address).dirty,false);
});

test('save carries the original artifact scope after Session switch',async()=>{
  const f=fixture((url,options)=>{
    if(options.method==='GET')return envelope([draft()]);
    const body=JSON.parse(options.body);
    return {schemaVersion:1,workspaceId:'w1',action:body.action,result:draft('d1',body.expectedRevision+1)};
  });
  const address={...scope,draftId:'d1'};await f.client.poll();f.select({workspaceId:'w2',sessionId:'s2'});
  const saved=await f.client.save(address,{...draft().plan,goal:'Saved'},draft());assert.equal(saved.revision,2);
  const body=JSON.parse(f.calls.at(-1).options.body);
  assert.equal(body.action,'draft-save');assert.equal(body.workspaceId,'w1');assert.equal(body.ticketId,'d1');
  assert.equal(body.expectedRevision,1);assert.equal(body.sessionId,'s1');assert.equal(body.plan.goal,'Saved');
});

test('reads started before a save cannot replace committed revision',async()=>{
  let reads=0,resolve;const f=fixture((url,options)=>{
    if(options.method==='POST')return {workspaceId:'w1',action:'draft-save',result:draft('d1',3)};
    if(++reads===2)return new Promise(done=>{resolve=done;});return envelope([draft()]);
  });
  const address={...scope,draftId:'d1'};await f.client.poll();const old=f.client.poll();
  await f.client.save(address,draft().plan,draft());resolve(envelope([draft('d1',2)]));await old;
  assert.equal(f.client.record(address).draft.revision,3);
});

test('cross-session backend responses are rejected and never accepted into records',async()=>{
  const f=fixture(()=>envelope([draft('d1',1,{originSessionId:'other'})]));await f.client.poll();
  assert.equal(f.client.latest(scope),null);
  await f.client.load(scope,{draftId:'d1'});assert.match(f.client.record({...scope,draftId:'d1'}).error.message,/Invalid/);
});

test('new remote drafts never displace the dirty editor flag and running Tickets are tracked like any record',async()=>{
  let drafts=[draft()];const f=fixture(()=>envelope(drafts));await f.client.poll();
  const address={...scope,draftId:'d1'};f.client.setDirty(address,true);
  drafts.push(draft('d2',1,{createdAt:'2026-11-12'}));await f.client.poll();
  assert.equal(f.client.record(address).dirty,true);assert.equal(f.client.latest(scope).id,'d2');
  drafts.push(draft('d3',1,{createdAt:'2026-11-13',status:'running'}));await f.client.poll();
  assert.equal(f.client.record({...scope,draftId:'d3'}).draft.status,'running');
  assert.equal(f.client.record(address).dirty,true);
});

test('save uses the editor base revision even when a newer clean remote revision is cached',async()=>{
  let remote=draft();const f=fixture((url,options)=>{if(options.method==='POST')throw Error('Revision conflict');return envelope([remote]);});
  await f.client.poll();remote=draft('d1',2);await f.client.poll();
  await f.client.save({...scope,draftId:'d1'},{...draft().plan,goal:'Editor contents'},draft());
  assert.equal(JSON.parse(f.calls.at(-1).options.body).expectedRevision,1);
});

test('dispose suppresses record updates from pending responses',async()=>{
  let resolve;const f=fixture(()=>new Promise(done=>{resolve=done;}));const reading=f.client.poll();f.client.dispose();resolve(envelope([draft()]));await reading;
  assert.equal(f.client.record({...scope,draftId:'d1'}).draft,null);
});

test('every canonical status and a null legacy plan reaches its read-only or recovery view unchanged',async()=>{
  for(const status of ['draft','running','stop-requested','stopped','delivered','superseded']){
    const ticket=draft('d1',5,{status,plan:null}),f=fixture(()=>envelope([ticket]));
    const loaded=await f.client.load({...scope,draftId:'d1'});
    assert.deepEqual(loaded,ticket);assert.equal(f.client.record({...scope,draftId:'d1'}).error,null);
  }
  const unknown = draft('unknown', 1, { status: 'not-a-ticket-status' });
  const client = fixture(() => envelope([unknown])).client;
  const address = { ...scope, draftId: unknown.id };
  assert.equal(await client.load(address), null);
  assert.match(client.record(address).error.message, /Invalid Fleet Ticket/);
  const malformed=draft();delete malformed.plan;
  const f=fixture(()=>envelope([malformed]));await f.client.load({...scope,draftId:'d1'});
  assert.match(f.client.record({...scope,draftId:'d1'}).error.message,/Invalid Fleet Ticket/);
});

test('stopped save keeps identity and real stopped status while preserving the plan payload',async()=>{
  const base=draft('d1',8,{status:'stopped'}),address={...scope,draftId:base.id};
  const plan={...base.plan,goal:'Stopped edit',inputs:{nested:{source:'keep'}},deliverables:['Separate file'],criteria:['one\ntwo'],requirements:'extra\nrequirements'};
  const f=fixture((url,options)=>options.method==='GET'?envelope([base]):{workspaceId:'w1',action:'draft-save',result:{...base,revision:9,plan}});
  await f.client.load(address);f.client.setDirty(address,true);
  const saved=await f.client.save(address,plan,base);assert.equal(saved.status,'stopped');assert.equal(saved.id,'d1');assert.equal(saved.revision,9);assert.equal(f.client.record(address).dirty,false);
  const sent=JSON.parse(f.calls.at(-1).options.body);assert.deepEqual(sent,{action:'draft-save',workspaceId:'w1',ticketId:'d1',expectedRevision:8,sessionId:'s1',plan});
});

test('newly locked remote status rejects an old editable base without posting or dropping dirty recovery',async()=>{
  for(const status of ['running','stop-requested','delivered','superseded']){
    let remote=draft();const f=fixture(()=>envelope([remote])),address={...scope,draftId:'d1'};
    await f.client.load(address);f.client.setDirty(address,true);remote=draft('d1',2,{status});await f.client.load(address);
    assert.equal(await f.client.save(address,{...draft().plan,goal:'keep local'},draft()),null);
    assert.equal(f.calls.filter(call=>call.options.method==='POST').length,0);assert.equal(f.client.record(address).dirty,true);
    assert.equal(f.client.record(address).error.fleetMessageKey,'ticketConfigurationLocked');assert.equal(f.client.record(address).draft.status,status);
  }
});

test('repair sends original Ticket identity and CAS scope without a lossy plan payload',async()=>{
  const legacy=draft('legacy',4,{plan:null}),address={...scope,draftId:'legacy'};
  const f=fixture((url,options)=>options.method==='GET'?envelope([legacy]):{workspaceId:'w1',action:'draft-repair',result:draft('legacy',5)});
  await f.client.load(address);const repaired=await f.client.repair(address,legacy);assert.equal(repaired.id,'legacy');assert.equal(repaired.revision,5);
  assert.deepEqual(JSON.parse(f.calls.at(-1).options.body),{action:'draft-repair',workspaceId:'w1',ticketId:'legacy',expectedRevision:4,sessionId:'s1'});
});

test('regeneration accepts a new Ticket identity and refreshes the superseded original without opening a resource',async()=>{
  let remote=draft('legacy',4,{plan:null});const replacement=draft('replacement',1,{createdAt:'2026-11-12'}),address={...scope,draftId:'legacy'};
  const f=fixture((url,options)=>{if(options.method==='GET')return envelope([remote],remote);remote={...remote,status:'superseded',revision:5,supersededBy:replacement.id};return {workspaceId:'w1',action:'draft-regenerate',result:replacement};});
  await f.client.load(address);const regenerated=await f.client.regenerate(address,remote);assert.deepEqual(regenerated,replacement);
  assert.deepEqual(JSON.parse(f.calls.find(call=>call.options.method==='POST').options.body),{action:'draft-regenerate',workspaceId:'w1',ticketId:'legacy',expectedRevision:4,sessionId:'s1'});
  assert.equal(f.client.record(address).draft.status,'superseded');assert.equal(f.client.record(address).draft.supersededBy,'replacement');
  assert.equal(f.client.record({...scope,draftId:'replacement'}).draft.id,'replacement');
});

test('regeneration after switching Sessions retains results for the original artifact scope',async()=>{
  let remote=draft('legacy',4,{plan:null});const f=fixture((url,options)=>{if(options.method==='GET')return envelope([remote]);remote={...remote,status:'superseded',revision:5};return {workspaceId:'w1',action:'draft-regenerate',result:draft('replacement')};});
  const address={...scope,draftId:'legacy'};await f.client.load(address);f.select({workspaceId:'w2',sessionId:'s2'});await f.client.regenerate(address,remote);
  assert.equal(f.client.record({...scope,draftId:'replacement'}).draft.id,'replacement');
});