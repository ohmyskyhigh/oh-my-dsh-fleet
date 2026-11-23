import { fleetResponseError } from './fleet-locale.js';
import { TICKET_STATUSES } from './fleet-model.js';

// Owns transport and revision state; the editor owns unsaved form contents.
// Records only: this client never opens resources or navigates. Surfaces mount
// the shared Dashboard Ticket detail themselves (Tab / side pane / fullscreen).
export function createFleetDraftClient({decode,fetcher=(...args)=>fetch(...args),getScope,signal,isEnabled=()=>true}) {
  const records=new Map(),listeners=new Set(),epochs=new Map(),pending=new Set();
  const acceptedReads=new Map();
  let readSequence=0,version=0,disposed=false;
  const scopeKey=scope=>JSON.stringify([scope.workspaceId,scope.sessionId]);
  const recordKey=scope=>JSON.stringify([scope.workspaceId,scope.sessionId,scope.draftId]);
  const sessionOf=value=>value?.originSessionId??value?.sessionId;
  const sameScope=(a,b)=>a&&b&&a.workspaceId===b.workspaceId&&sessionOf(a)===sessionOf(b);
  const validScope=scope=>scope&&typeof scope.workspaceId==='string'&&!!scope.workspaceId&&typeof scope.sessionId==='string'&&!!scope.sessionId;
  const notify=()=>{if(disposed)return;version++;for(const listener of listeners)listener();};
  function record(scope) {
    const key=recordKey(scope);
    if(!records.has(key))records.set(key,{draft:null,dirty:false,busy:false,error:null});
    return records.get(key);
  }
  function validate(draft,scope) {
    if(!draft||typeof draft.id!=='string'||!draft.id||draft.workspaceId!==scope.workspaceId||draft.originSessionId!==scope.sessionId||!Number.isSafeInteger(draft.revision)||draft.revision<1||!TICKET_STATUSES.includes(draft.status)||!Object.hasOwn(draft,'plan'))throw new Error('Invalid Fleet Ticket response');
    return draft;
  }
  function accept(draft,{force=false}={}) {
    const row=record({workspaceId:draft.workspaceId,sessionId:draft.originSessionId,draftId:draft.id});
    if((force||!row.busy)&&(!row.draft||draft.revision>=row.draft.revision))row.draft=draft;
    if(force){row.dirty=false;row.error=null;}
    return row;
  }
  async function load(scope,{draftId=scope?.draftId,force=false}={}) {
    if(disposed||!validScope(scope)||!isEnabled(scope.workspaceId))return null;
    const key=scopeKey(scope),requestKey=JSON.stringify([key,draftId??null]);
    if(pending.has(requestKey)&&!force)return null;
    const epoch=epochs.get(key)||0,sequence=++readSequence;
    pending.add(requestKey);
    try {
      const query=new URLSearchParams({workspaceId:scope.workspaceId,sessionId:scope.sessionId,...(draftId?{draftId}:{})});
      const body=await decode(await fetcher(`/api/fleet/drafts?${query}`,{method:'GET',credentials:'same-origin',signal}));
      if(body.workspaceId!==scope.workspaceId||!Array.isArray(body.drafts))throw new Error('Invalid Fleet drafts response');
      for(const draft of body.drafts)validate(draft,scope);
      if(body.selectedDraft)validate(body.selectedDraft,scope);
      if(draftId&&body.selectedDraft?.id!==draftId)throw new Error('Fleet draft is unavailable');
      if(disposed||(epochs.get(key)||0)!==epoch||!isEnabled(scope.workspaceId))return null;
      if(sequence<(acceptedReads.get(key)||0))return null;
      acceptedReads.set(key,sequence);
      if(!draftId){
        const presentIds=new Set(body.drafts.map(draft=>draft.id));
        for(const [address,row] of records){
          if(!row.busy&&sameScope(row.draft,scope)&&!presentIds.has(row.draft.id))records.delete(address);
        }
      }
      for(const draft of body.drafts)accept(draft);
      if(body.selectedDraft)accept(body.selectedDraft,{force:force&&!!draftId});
      notify();
      return body.selectedDraft??null;
    }catch(error){if(!disposed&&draftId){record({...scope,draftId}).error=error;notify();}return null;}
    finally{pending.delete(requestKey);}
  }
  async function mutate(scope,action,plan,baseDraft,options) {
    const row=record(scope),base=baseDraft||row.draft;
    if(disposed||row.busy||!base||!isEnabled(scope.workspaceId))return null;
    validate(base,scope);
    if(base.id!==scope.draftId)return null;
    if(action==='draft-save'&&![base.status,row.draft?.status??base.status].every(status=>['draft','stopped'].includes(status))){row.error=fleetResponseError('ticketConfigurationLocked');notify();return null;}
    // P-67：draft-save 可选范围扩展；series 范围需 seriesId＋expectedSeriesRevision（双 CAS 同事务）。
    const scopeFields={};
    if(action==='draft-save'&&options&&options.scope){
      if(options.scope==='series'){
        if(typeof options.seriesId!=='string'||!options.seriesId||!Number.isSafeInteger(options.expectedSeriesRevision)){row.error=new Error('Series scope requires seriesId and expectedSeriesRevision');notify();return null;}
        Object.assign(scopeFields,{scope:'series',seriesId:options.seriesId,expectedSeriesRevision:options.expectedSeriesRevision});
      }else if(options.scope==='ticket')scopeFields.scope='ticket';
    }
    row.busy=true;row.error=null;
    const key=scopeKey(scope);epochs.set(key,(epochs.get(key)||0)+1);notify();
    try {
      const args={workspaceId:scope.workspaceId,ticketId:base.id,expectedRevision:base.revision,sessionId:scope.sessionId,...scopeFields,...(plan===undefined?{}:{plan})};
      const body=await decode(await fetcher('/api/fleet/action',{method:'POST',credentials:'same-origin',signal,headers:{'content-type':'application/json'},body:JSON.stringify({action,...args})}));
      if(body.workspaceId!==scope.workspaceId||body.action!==action)throw new Error('Invalid Fleet draft action response');
      const payload=action==='draft-save'&&scopeFields.scope==='series'?body.result?.ticket:body.result;
      const draft=validate(payload,scope);
      if(action!=='draft-regenerate'&&draft.id!==base.id)throw new Error('Invalid Fleet Ticket identity');
      if(disposed)return null;
      accept(draft,{force:true});
      // The caller navigates its own surface to the replacement; no resource opens here.
      if(action==='draft-regenerate')await load(scope,{draftId:base.id,force:true});
      return draft;
    }catch(error){if(!disposed)row.error=error;return null;}
    finally{row.busy=false;epochs.set(key,(epochs.get(key)||0)+1);notify();}
  }
  return {
    getSnapshot:()=>version,subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    latest:scope=>[...records.values()].map(row=>row.draft).filter(draft=>sameScope(draft,scope)).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))||String(b.id).localeCompare(String(a.id)))[0]??null,
    record,load,poll:()=>{const scope=getScope();return scope?load(scope):Promise.resolve(null);},
    save:(scope,plan,baseDraft,options)=>mutate(scope,'draft-save',plan,baseDraft,options),
    repair:(scope,baseDraft)=>mutate(scope,'draft-repair',undefined,baseDraft),
    regenerate:(scope,baseDraft)=>mutate(scope,'draft-regenerate',undefined,baseDraft),
    reload:scope=>load(scope,{draftId:scope.draftId,force:true}),
    setDirty(scope,dirty){record(scope).dirty=!!dirty;},
    dispose(){disposed=true;listeners.clear();records.clear();}
  };
}
