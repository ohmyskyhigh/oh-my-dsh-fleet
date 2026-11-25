import { mountWorkspaceDashboardLinks } from './fleet-workspace-nav.js';
import { fleetStyles } from './fleet-theme.js';
import { createFleetViews } from './fleet-ui.js';
import { createFleetLanguage, fleetDictionaries, fleetTranslator, fleetResponseError, fleetErrorRecord, fleetErrorText } from './fleet-locale.js';
import { createFleetDraftClient } from './fleet-draft-client.js';
import { projectTicket, isIncompatibleDraft } from './fleet-model.js';

export function draftRecreationPrompt(ticket, language = 'zh') {
  const goal = [ticket.plan?.goal,ticket.plan?.ticket?.goal,ticket.goal,ticket.legacy?.original?.plan?.goal,ticket.legacy?.original?.plan?.ticket?.goal,ticket.legacy?.original?.goal].find(value=>typeof value==='string'&&value.trim());
  const request = typeof goal === 'string' && goal.trim() ? `/fleet new ${goal}` : (language === 'zh' ? '请先从旧草稿中恢复原任务目标；如果没有明确目标，请先询问我，暂不创建草稿。' : 'First recover the original goal from the previous draft. If no clear goal exists, ask me before creating a draft.');
  const reference = `${ticket.id} (revision ${ticket.revision})`;
  return language === 'zh'
    ? `${request}\n\n请基于旧草稿 ${reference}，重新规划一个兼容当前版本的新草稿。先读取旧草稿及当前全局模板和规则，保留原目标、输入、交付物、验收标准、补充要求、Agent 分工和各 Gate 的审核意图。将旧版 Gate 范围说明里明确的审核输入和检查项写入审核任务，返工说明继续放在返工配置里；无法明确转换的要求请向我确认。按照当前支持的数据格式，在这个新对话中保存新的 Ticket 草稿。旧草稿仅作参考，保留不变。只生成草稿，不启动执行。`
    : `${request}\n\nReplan a draft compatible with the current version using previous Ticket ${reference}. Read that Ticket and the current global Templates and rules first. Preserve its goal, inputs, deliverables, acceptance criteria, additional requirements, Agent assignments and each Gate's review intent. Put explicit review inputs and checks from old Gate scope notes into the review task and keep rework guidance in the rework configuration. Ask me about anything that cannot be mapped clearly. Save a new Ticket draft in this new conversation using the supported format. Keep the previous Ticket unchanged as reference. Prepare the draft only; do not start execution.`;
}

export function createFleetPlugin(require) {
  const React = require('react');
  const h = React.createElement;
  const views = createFleetViews(React);
  const PANEL_ID = 'dsh-fleet';
  const CONTROL_ID = 'dsh-fleet-control';
  const NS = 'dshFleetShell';
  function FleetIcon({size=20}) {
    return h('svg',{viewBox:'0 0 36 36',width:size,height:size,fill:'currentColor','aria-hidden':true,focusable:false,style:{display:'block',flexShrink:0}},
      h('path',{fillRule:'evenodd',transform:'translate(2.2 1) scale(.88)',d:'M8 6a4.5 4.5 0 0 1 6 2 16 16 0 0 1 8 0 4.5 4.5 0 1 1 7 5c2 2 3 5 3 8 0 7-6 11-14 11S4 28 4 21c0-3 1-6 3-8a4.5 4.5 0 0 1 1-7zM14 17a2 2 0 1 0-4 0 2 2 0 1 0 4 0zm12 0a2 2 0 1 0-4 0 2 2 0 1 0 4 0zM13 23h10v3a2 2 0 0 1-2 2h-2v-3h-2v3h-2a2 2 0 0 1-2-2z'}));
  }
  return {
    inject:['slots','locale','layout','workspaces','sessions','uiWorkspace','sidebarRight','sidebarRightTabs','conversation'],
    apply(ctx) {
      ctx.effect(()=>ctx.locale.register(NS,fleetDictionaries),'fleet: dictionaries');
      const languageStore=createFleetLanguage(ctx.locale);
      ctx.effect(()=>()=>languageStore.dispose(),'fleet: language preference');
      const localizeError=(state,t)=>({...state,error:fleetErrorText(state.error,t)});
      let workspaceId=null, disposed=false, viewVersion=0, navigationGeneration=0, creatingTicket=false;
      const listeners=new Set(), modeListeners=new Set(), viewListeners=new Set(), cache=new Map();
      const selection={getSnapshot:()=>workspaceId,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}};
      let state={ready:false,pending:false,error:null,notice:false,enabledWorkspaceIds:[]};
      const modes={getSnapshot:()=>state,subscribe:listener=>{modeListeners.add(listener);return()=>modeListeners.delete(listener);}};
      const viewStore={getSnapshot:()=>viewVersion,subscribe:listener=>{viewListeners.add(listener);return()=>viewListeners.delete(listener);}};
      const abort=new AbortController();
      const notifyViews=()=>{if(disposed)return;viewVersion++;for(const listener of viewListeners)listener();};
      const publish=patch=>{if(disposed)return;state={...state,...patch};for(const listener of modeListeners)listener();};
      function viewFor(id) {
        if(!cache.has(id))cache.set(id,{data:{ready:false,pending:false,error:null,tickets:[],catalog:{}},ui:{page:'overview',query:'',filter:'all'},drafts:new Map(),busy:false,requestId:0});
        return cache.get(id);
      }
      function setUI(id,patch) {if(disposed)return;const view=viewFor(id);view.ui={...view.ui,...patch};notifyViews();}
      const registered=id=>ctx.workspaces.list.getSnapshot().items.some(item=>item.workspaceId===id);
      async function decode(response) {
        const body=await response.json();
        if(!response.ok)throw Object.assign(new Error(body.error?.message||body.message||`HTTP ${response.status}`),{code:body.error?.code,references:body.error?.references});
        if(body.schemaVersion!==1)throw fleetResponseError('invalidResponseVersion');
        return body;
      }
      function draftScope(address) {
        try {
          const url=new URL(address),parts=url.pathname.slice(1).split('/').map(decodeURIComponent);
          if(url.protocol!=='dsh-resource:'||url.hostname!=='fleet-ticket-draft'||parts.length!==3||parts.some(part=>!part))return null;
          return {workspaceId:parts[0],sessionId:parts[1],draftId:parts[2]};
        }catch{return null;}
      }
      const activeDraftScope=()=>{
        const sessionId=ctx.sidebarRight?.mounted?.getSnapshot();
        const workspace=ctx.workspaces.list.getSnapshot().items.find(item=>item.sessionIds?.includes(sessionId));
        return sessionId&&workspace?{workspaceId:workspace.workspaceId,sessionId}:null;
      };
      const draftClient=createFleetDraftClient({decode,getScope:activeDraftScope,signal:abort.signal,isEnabled:id=>registered(id)&&state.enabledWorkspaceIds.includes(id)});
      async function requestModes(change) {
        if(disposed||state.pending)return;
        publish({pending:true,error:null,notice:false});
        try {
          const body=await decode(await fetch('/api/fleet/modes',{method:change?'POST':'GET',credentials:'same-origin',signal:abort.signal,...(change?{headers:{'content-type':'application/json'},body:JSON.stringify(change)}:{})}));
          if(!Array.isArray(body.enabledWorkspaceIds)||body.enabledWorkspaceIds.some(id=>typeof id!=='string'))throw fleetResponseError('invalidModesResponse');
          publish({ready:true,pending:false,error:null,notice:!!change,enabledWorkspaceIds:body.enabledWorkspaceIds});
          if(ctx.sidebarRight?.mounted)void draftClient.poll();
        }catch(error){publish({pending:false,error:fleetErrorRecord(error),notice:false});}
      }
      async function requestView(id,force=false) {
        if(disposed||!registered(id)||!state.enabledWorkspaceIds.includes(id))return;
        const view=viewFor(id);
        if(view.data.pending&&!force)return;
        const requestId=++view.requestId;
        view.data={...view.data,pending:true};notifyViews();
        try {
          const body=await decode(await fetch(`/api/fleet/view?workspaceId=${encodeURIComponent(id)}`,{method:'GET',credentials:'same-origin',signal:abort.signal}));
          if(body.workspaceId!==id||!Array.isArray(body.tickets)||!Array.isArray(body.catalog?.agents)||!Array.isArray(body.catalog?.orchestrations)||body.tickets.some(ticket=>ticket.workspaceId!==id))throw fleetResponseError('invalidWorkspaceResponse');
          if(disposed||view.requestId!==requestId)return;
          if(!registered(id)||!state.enabledWorkspaceIds.includes(id)){view.data={...view.data,pending:false};notifyViews();return;}
          view.data={...body,ready:true,pending:false,error:null};
          reconcileTicketSelections(id);
          notifyViews();
        }catch(error){if(!disposed&&view.requestId===requestId){view.data={...view.data,pending:false,error:fleetErrorRecord(error)};notifyViews();}}
      }
      async function act(id,action,args,t,sink=null) {
        const view=viewFor(id);
        const target=sink??panelSink(id,view);
        if(disposed||view.busy||!registered(id)||!state.enabledWorkspaceIds.includes(id))return null;
        view.busy=true;
        // A GET started before this write must never replace its refreshed result.
        view.requestId++;view.data={...view.data,pending:false};target.patch({error:null,dialogError:null,notice:null});
        try {
          const body=await decode(await fetch('/api/fleet/action',{method:'POST',credentials:'same-origin',signal:abort.signal,headers:{'content-type':'application/json'},body:JSON.stringify({workspaceId:id,action,...args})}));
          if(body.workspaceId!==id||body.action!==action||(action==='draft-delete'&&body.result?.deletedTicketId!==args.ticketId))throw fleetResponseError('invalidActionResponse');
          if(disposed)return null;
          if(action==='draft-delete'){
            view.data={...view.data,tickets:view.data.tickets.filter(ticket=>ticket.id!==args.ticketId)};
            reconcileTicketSelections(id);
          }
          const openDialog=target.get().dialog;
          const keepDialog=(action==='draft-save'&&openDialog?.kind==='revise')||(action==='series-create'&&['schedule','revise'].includes(openDialog?.kind));
          const next={dialog:keepDialog?openDialog:null,dialogError:null,notice:action==='draft-delete'?'draftDeleted':'actionSaved'};
          if((action==='draft-regenerate'||action==='template-instantiate')&&body.result?.id)Object.assign(next,{page:'ticket',ticketId:body.result.id,nodeId:null});
          target.patch(next);
          await requestView(id,true);
          return body;
        }catch(error){
          if(!disposed){
            const detail=fleetErrorRecord(error);
            const dialog=target.get().dialog;
            target.patch({error:action==='draft-delete'&&dialog?null:detail,...(dialog?{dialogError:detail}:{})});
            if(action==='draft-delete'||['fleet/scope-required','fleet/stale-revision','fleet/dependency-wait'].includes(error.code))await requestView(id,true);
          }
          return null;
        }
        finally{view.busy=false;notifyViews();}
      }
      ctx.effect(()=>{
        void requestModes();
        const unsubscribeNavigation=ctx.layout.panelInfo?.subscribe?.(()=>{navigationGeneration++;});
        const unsubscribeSession=ctx.sidebarRight?.mounted?.subscribe(()=>{void draftClient.poll();});
        const unsubscribeWorkspaces=ctx.workspaces.list.subscribe?.(()=>{void draftClient.poll();});
        const timer=setInterval(()=>{
          if(!disposed&&!globalThis.document?.hidden&&ctx.sidebarRight?.mounted)void draftClient.poll();
          if(!disposed&&workspaceId&&ctx.layout.panelInfo?.getSnapshot().activePanelId===PANEL_ID&&!globalThis.document?.hidden&&!viewFor(workspaceId).busy)void requestView(workspaceId);
        },4000);
        timer.unref?.();
        return()=>{disposed=true;clearInterval(timer);unsubscribeNavigation?.();unsubscribeSession?.();unsubscribeWorkspaces?.();draftClient.dispose();abort.abort();listeners.clear();modeListeners.clear();viewListeners.clear();cache.clear();tabScopes.clear();tabMounts.clear();paneScopes.clear();};
      },'fleet: mode, view and request lifetime');
      const navigateTicket=(id,ticketId)=>{
        const incompatible=isIncompatibleDraft(viewFor(id).data.tickets.find(ticket=>ticket.id===ticketId));
        setUI(id,{page:incompatible?'tickets':'ticket',ticketId:incompatible?null:ticketId,nodeId:null,error:null,notice:null,dialog:null});
      };
      /* Session-tab surfaces share the Workspace data cache but keep their own ui state,
         so the chat tab and the fullscreen panel never navigate each other. */
      const tabScopes=new Map(),tabMounts=new Set(),paneScopes=new Map();
      function reconcileTicketSelections(id){
        const view=viewFor(id);
        const reconcile=(scope,allowIncompatible)=>{
          const ui=scope.ui;
          if(ui.page!=='ticket')return;
          const selected=view.data.tickets.find(ticket=>ticket.id===ui.ticketId);
          if(selected&&(allowIncompatible||!isIncompatibleDraft(selected)))return;
          scope.ui={...ui,page:'tickets',ticketId:null,nodeId:null,gateId:null,attemptId:null,dialog:null,dialogError:null};
        };
        reconcile(view,false);
        for(const scope of tabScopes.values())if(scope.workspaceId===id)reconcile(scope,true);
      }
      function tabScope(sessionId,workspaceId){
        let scope=tabScopes.get(sessionId);
        if(!scope||scope.workspaceId!==workspaceId){scope={workspaceId,ui:{page:'overview',query:'',filter:'all',initialized:false}};tabScopes.set(sessionId,scope);}
        return scope;
      }
      const setScopeUI=(sessionId,patch)=>{
        const scope=tabScopes.get(sessionId);if(!scope)return;
        scope.ui={...scope.ui,...patch,...(Object.hasOwn(patch,'page')?{initialized:true}:{})};
        notifyViews();
      };
      /* Side-pane resources stay pinned to one Ticket: ui always holds page 'ticket';
         navigate('ticket', otherId) retargets the pane in place, other pages open the
         fullscreen Workspace Dashboard instead of moving the pane. */
      function paneScope(key,draftId) {
        let scope=paneScopes.get(key);
        if(!scope){scope={ui:{page:'ticket',ticketId:draftId,nodeId:null,query:'',filter:'all'}};paneScopes.set(key,scope);}
        return scope;
      }
      const draftDirtyTracker=(workspaceId,fallbackSessionId,getTicketId)=>dirty=>{
        const ticketId=getTicketId();if(!ticketId)return;
        const shown=viewFor(workspaceId).data.tickets.find(ticket=>ticket.id===ticketId);
        const sessionId=shown?.originSessionId??fallbackSessionId;if(!sessionId)return;
        draftClient.setDirty({workspaceId,sessionId,draftId:ticketId},dirty);
      };
      const navigateScopeTicket=(sessionId,wsId,ticketId)=>{
        const incompatible=!wsId||isIncompatibleDraft(viewFor(wsId).data.tickets.find(ticket=>ticket.id===ticketId));
        setScopeUI(sessionId,{page:incompatible?'tickets':'ticket',ticketId:incompatible?null:ticketId,nodeId:null,error:null,notice:null,dialog:null});
      };
      const panelSink=(id,view)=>({get:()=>view.ui,patch:patch=>setUI(id,patch)});
      async function createDraftConversation(id,language,ticketId=null,originSessionId=null,sink=null) {
        const view=viewFor(id);
        const target=sink??panelSink(id,view);
        const stillHere=()=>originSessionId
          ?tabMounts.has(originSessionId)||(activeDraftScope()?.sessionId===originSessionId&&activeDraftScope()?.workspaceId===id)
          :workspaceId===id&&(!ctx.layout.panelInfo||ctx.layout.panelInfo.getSnapshot().activePanelId===PANEL_ID);
        if(disposed||creatingTicket||view.busy||!registered(id)||!state.enabledWorkspaceIds.includes(id)||!stillHere())return;
        const workspaceSource=ticketId===null?null:view.data.tickets.find(ticket=>ticket.id===ticketId);
        const sessionSource=ticketId!==null&&originSessionId?draftClient.record({workspaceId:id,sessionId:originSessionId,draftId:ticketId}).draft:null;
        const source=(view.data.ready&&!workspaceSource?[]:[workspaceSource,sessionSource]).filter(ticket=>ticket?.id===ticketId&&ticket.workspaceId===id).reduce((latest,ticket)=>!latest||ticket.revision>=latest.revision?ticket:latest,null);
        if(ticketId!==null&&(!source||source.workspaceId!==id||!isIncompatibleDraft(source))){target.patch({error:fleetErrorRecord(new Error(language==='zh'?'此草稿已发生变化，请刷新后重试。':'This draft has changed. Refresh and try again.'))});return;}
        const prompt=source?draftRecreationPrompt(source,language):'/fleet new ';
        creatingTicket=true;view.busy=true;const generation=navigationGeneration;target.patch({error:null});
        try {
          const sessionId=await ctx.sessions.create({workspaceId:id});
          if(disposed||generation!==navigationGeneration||!stillHere()||!registered(id)||!state.enabledWorkspaceIds.includes(id))return;
          ctx.uiWorkspace.openSession(sessionId);
          const result=ctx.conversation.input.requestDraftInitialization(ctx.sessions.binding(sessionId),{prompt,whenDraftExists:'keep'});
          if(result!=='applied'){
            selectWorkspace(id);
            throw new Error(language==='zh'?'新对话已创建，但无法填入命令；已有输入已保留。':'The new conversation was created, but the command could not be inserted. Existing input was preserved.');
          }
        }catch(error){target.patch({error:fleetErrorRecord(error)});}
        finally{creatingTicket=false;view.busy=false;notifyViews();}
      }
      // P-69 Root overview cache: read-only, one aggregated request; each project reports its own state.
      let overview={ready:false,pending:false,error:null,pluginVersion:null,projects:[],series:[],admin:null,scheduleStatus:null};
      let overviewUi={tab:'attention',showHidden:false};
      const setOverviewUI=patch=>{overviewUi={...overviewUi,...patch};notifyViews();};
      async function requestOverview(){
        if(disposed||overview.pending)return;
        overview={...overview,pending:true,error:null};notifyViews();
        try{
          const body=await decode(await fetch('/api/fleet/overview',{method:'GET',credentials:'same-origin',signal:abort.signal}));
          if(!Array.isArray(body.projects))throw fleetResponseError('invalidWorkspaceResponse');
          const series=body.projects.flatMap(project=>(Array.isArray(project.series)?project.series:[]).map(item=>({...item,workspaceId:project.workspaceId,projectTitle:project.title||project.path?.split(/[\\/]/).filter(Boolean).pop()||project.workspaceId})));
          if(disposed)return;
          overview={ready:true,pending:false,error:null,pluginVersion:body.pluginVersion,projects:body.projects,series,scheduleStatus:body.scheduleStatus??null,admin:body.admin??null};
        }catch(error){if(disposed)return;overview={...overview,pending:false,error:error?.message||String(error)};}
        notifyViews();
      }
      const selectWorkspace=id=>{
        if(!state.ready||!state.enabledWorkspaceIds.includes(id)||!registered(id))return;
        navigationGeneration++;workspaceId=id;
        for(const listener of listeners)listener();
        ctx.layout.selectPanel(PANEL_ID);
        void requestView(id);
      };
      function SidebarFleetIcon(props) {
        const anchor=React.useRef(null);
        React.useEffect(()=>{
          const root=anchor.current?.closest('[class*="_sidebarCol"]');if(!root)return;
          return mountWorkspaceDashboardLinks({root,label:'oh-my-dsh-fleet',getState:()=>({language:languageStore.getSnapshot().language,dashboardLabel:fleetTranslator(languageStore.getSnapshot().language)('title'),workspaces:ctx.workspaces.list.getSnapshot().items.map(item=>({workspaceId:item.workspaceId,label:item.title||item.path?.split(/[\\/]/).filter(Boolean).pop()||item.workspaceId})),enabledWorkspaceIds:state.enabledWorkspaceIds,activeWorkspaceId:ctx.layout.panelInfo.getSnapshot().activePanelId===PANEL_ID?workspaceId:null}),subscribe:listener=>{const cleanups=[selection,modes,languageStore,ctx.workspaces.list,ctx.layout.panelInfo].map(source=>source.subscribe(listener));return()=>{for(const cleanup of cleanups.reverse())cleanup();};},onOpen:selectWorkspace});
        },[]);
        return h('span',{ref:anchor,style:{display:'contents'}},h(FleetIcon,props));
      }
      const inject=()=>({hooks:{fleetLanguage:languageStore,fleetWorkspace:selection,fleetModes:modes,fleetViews:viewStore,fleetWorkspaces:ctx.workspaces.list,fleetSessions:ctx.sessions.list}});
      function ControlPanel({useFleetLanguage,useFleetWorkspaces,useFleetModes,useFleetViews}) {
        useFleetViews(value=>value);
        React.useEffect(()=>{void requestOverview();},[]);
        const locale=useFleetLanguage(value=>value),t=fleetTranslator(locale.language);
        const workspaces=useFleetWorkspaces(value=>value.items), mode=useFleetModes(value=>value);
        const canManage=id=>state.ready&&registered(id)&&state.enabledWorkspaceIds.includes(id);
        const openTicket=(wsId,ticketId)=>{if(!registered(wsId))return;if(!state.enabledWorkspaceIds.includes(wsId)){publish({error:fleetErrorRecord(new Error(locale.language==='zh'?'该项目的 Fleet 模式已关闭。请在「工作区配置」中开启后再进入。':'Fleet mode is off for this project. Enable it in Workspace settings to open the Ticket.'))});return;}selectWorkspace(wsId);const summary=overview.projects.find(project=>project.workspaceId===wsId)?.tickets.find(ticket=>ticket.id===ticketId);if(summary?.incompatible)setUI(wsId,{page:'tickets',ticketId:null,dialog:{kind:'preview',ticketId},dialogError:null,error:null,notice:null});else navigateTicket(wsId,ticketId);};
        const toggleWorkspace=async(wsId,enabled)=>{await requestModes({workspaceId:wsId,enabled});void requestOverview();};
        const actSeries=async(action,args,item)=>{if(!canManage(item.workspaceId))return null;const result=await act(item.workspaceId,action,args,t);void requestOverview();return result;};
        const openSeries=(dialog,item)=>{if(!canManage(item.workspaceId))return;selectWorkspace(item.workspaceId);setUI(item.workspaceId,{page:'schedules',scheduleId:item.id,error:null,notice:null,dialog,dialogError:null});};
        return h('section',{className:'dsh-fleet-shell dsh-fleet-control','data-fleet-control':'',lang:locale.language==='zh'?'zh-CN':'en','aria-labelledby':'fleet-control-title'},h('style',null,fleetStyles),views.renderRootOverview({t,...locale,workspaces,ui:overviewUi,setUI:setOverviewUI,setLanguagePreference:languageStore.setPreference,pluginVersion:overview.pluginVersion,projects:overview.projects,series:overview.series,admin:overview.admin,scheduleStatus:overview.scheduleStatus,pending:overview.pending||state.pending,error:overview.error||localizeError(mode,t).error,notice:state.notice?t('saved'):null,mode:localizeError(mode,t),refresh:()=>{void requestModes();void requestOverview();},openTicket,openWorkspace:selectWorkspace,toggleWorkspace,actSeries,openSeries,returnToConversation:()=>ctx.layout.selectPanel(null)}));
      }
      function FleetPanel({useFleetLanguage,useFleetWorkspace,useFleetModes,useFleetViews,useFleetWorkspaces,useFleetSessions}) {
        const locale=useFleetLanguage(value=>value),t=fleetTranslator(locale.language);
        const id=useFleetWorkspace(value=>value), workspace=useFleetWorkspaces(value=>value.items.find(item=>item.workspaceId===id)), mode=useFleetModes(value=>value), sessionMap=useFleetSessions(value=>value.byId);
        useFleetViews(value=>value);
        const enabled=mode.ready&&mode.enabledWorkspaceIds.includes(id), view=viewFor(id), ui=view.ui;
        const panelRef=React.useRef(null);
        React.useEffect(()=>{panelRef.current?.scrollTo({top:0,left:0,behavior:'instant'});},[id,ui.page,ui.ticketId,ui.agentId,ui.flowId]);
        const members=(workspace?.sessionIds??[]).filter(sessionId=>sessionMap[sessionId]);
        const openChat=async sessionId=>{try{if(sessionId)await ctx.uiWorkspace.openSession(sessionId);else await ctx.uiWorkspace.openWorkspace(id);}catch(error){publish({error:fleetErrorRecord(error)});}};
        const createTicket=()=>createDraftConversation(id,locale.language);
        const action=(name,args)=>act(id,name,args,t);
        return h('section',{ref:panelRef,className:'dsh-fleet-shell','data-dsh-fleet-shell':'',lang:locale.language==='zh'?'zh-CN':'en','data-fleet-panel-workspace-id':workspace&&enabled?workspace.workspaceId:'','aria-labelledby':'dsh-fleet-shell-title'},h('style',null,fleetStyles),views.renderDashboard({
          t,...locale,setLanguagePreference:languageStore.setPreference,workspace,mode:localizeError(mode,t),enabled,members,sessionMap,openChat,ui:{...localizeError(ui,t),dialogError:fleetErrorText(ui.dialogError,t),notice:ui.notice?t(ui.notice):null},data:localizeError(view.data,t),busy:view.busy,
          setUI:patch=>setUI(id,patch),navigate:(page,patch={})=>page==='ticket'?navigateTicket(id,patch.ticketId):setUI(id,{page,error:null,notice:null,dialog:null,...patch}),openDialog:dialog=>dialog.kind==='prepare'?createTicket():setUI(id,{dialog,dialogError:null,error:null,notice:null}),createTicket,creatingTicket,recreateDraft:ticket=>createDraftConversation(id,locale.language,ticket.id),
          act:action,refresh:()=>requestView(id),toControl:()=>ctx.layout.selectPanel(CONTROL_ID),returnToConversation:()=>ctx.layout.selectPanel(null),
          onDraftDirtyChange:draftDirtyTracker(id,null,()=>ui.ticketId)
        }));
      }
      if(ctx.sidebarRightTabs&&ctx.sidebarRight?.mounted) {
        const DRAFT_TYPE='oh-my-agent-fleet/ticket-draft';
        ctx.effect(()=>ctx.sidebarRightTabs.register({id:DRAFT_TYPE,kind:'fleet-ticket-draft',patterns:['dsh-resource://fleet-ticket-draft/**'],priority:'extension',keepMounted:true,title:()=>languageStore.getSnapshot().language==='zh'?'Ticket 详情':'Ticket detail'}),'fleet: native Ticket detail artifact');
        /* The side pane mounts the same shared Dashboard Ticket detail as the Session
           tab and the fullscreen panel (surface 'side-pane'). The standalone draft
           editor pane and the conversation-header entry are gone: users enter through
           the Fleet Tab, and explicit draft resources render this pinned detail.
           Draft editing happens in ticketView's revise dialog via act('draft-save'). */
        function DraftPane({sessionId,useTabInfo,useFleetLanguage,useFleetDrafts,useFleetViews,useFleetModes,useFleetWorkspaces,useFleetSessions}) {
          const locale=useFleetLanguage(value=>value),t=fleetTranslator(locale.language);
          useFleetDrafts(value=>value);useFleetViews(value=>value);
          const mode=useFleetModes(value=>value),workspaces=useFleetWorkspaces(value=>value.items),sessionMap=useFleetSessions(value=>value.byId);
          const tab=useTabInfo().tab,scope=draftScope(tab.navigation?.address);
          const workspace=scope?workspaces.find(item=>item.workspaceId===scope.workspaceId):null;
          const valid=!!scope&&scope.sessionId===sessionId&&!!workspace&&!!workspace.sessionIds?.includes(scope.sessionId)&&mode.enabledWorkspaceIds.includes(scope.workspaceId);
          const paneKey=valid?JSON.stringify([scope.workspaceId,scope.sessionId,scope.draftId]):null;
          const pane=valid?paneScope(paneKey,scope.draftId):null;
          React.useEffect(()=>{
            if(!valid)return;
            void draftClient.load(scope,{draftId:scope.draftId});
            void requestView(scope.workspaceId);
            const timer=setInterval(()=>{if(!disposed&&!globalThis.document?.hidden&&!viewFor(scope.workspaceId).busy)void requestView(scope.workspaceId);},4000);
            timer.unref?.();
            return()=>clearInterval(timer);
          },[valid,scope?.workspaceId,scope?.sessionId,scope?.draftId]);
          const shell=children=>h('section',{className:'dsh-fleet-shell','data-fleet-draft-artifact':'','data-fleet-surface':'side-pane',lang:locale.language==='zh'?'zh-CN':'en'},h('style',null,fleetStyles),...children);
          if(!valid)return shell([h('p',{role:'alert'},locale.language==='zh'?'此草稿不属于当前对话或工作区未启用。':'This draft does not belong to this conversation or its workspace is disabled.')]);
          const view=viewFor(scope.workspaceId),ui=pane.ui,row=draftClient.record({...scope,draftId:ui.ticketId});
          if(view.data.ready&&!view.data.tickets.some(ticket=>ticket.id===ui.ticketId&&ticket.originSessionId===sessionId))return shell([h('p',{role:'alert'},t('ticketUnavailable'))]);
          const setUIFn=patch=>{const {page,...rest}=patch;pane.ui={...pane.ui,...rest};notifyViews();};
          const sink={get:()=>pane.ui,patch:setUIFn};
          const navigateFn=(page,patch={})=>{
            if(page==='ticket'&&patch.ticketId&&view.data.tickets.some(ticket=>ticket.id===patch.ticketId&&ticket.originSessionId===sessionId)){pane.ui={...pane.ui,ticketId:patch.ticketId,nodeId:patch.nodeId??null,error:null,notice:null,dialog:null};notifyViews();return;}
            selectWorkspace(scope.workspaceId);
            setUI(scope.workspaceId,{page,scheduleId:patch.scheduleId??null,ticketId:patch.ticketId??null,nodeId:patch.nodeId??null,agentId:patch.agentId??null,flowId:patch.flowId??null,error:null,notice:null,dialog:null});
          };
          const members=(workspace.sessionIds??[]).filter(sid=>sessionMap[sid]);
          const openChat=async sid=>{try{if(sid)await ctx.uiWorkspace.openSession(sid);else await ctx.uiWorkspace.openWorkspace(scope.workspaceId);}catch(error){setUIFn({error:fleetErrorRecord(error)});}};
          const createTicket=()=>createDraftConversation(scope.workspaceId,locale.language,null,sessionId,sink);
          return shell([views.renderDashboard({
            t,...locale,setLanguagePreference:languageStore.setPreference,workspace,mode:localizeError(mode,t),enabled:true,members,sessionMap,openChat,
            ui:{...localizeError(ui,t),error:localizeError(ui,t).error||(row.error?fleetErrorText(fleetErrorRecord(row.error),t):null),dialogError:fleetErrorText(ui.dialogError,t),notice:ui.notice?t(ui.notice):null},data:localizeError(view.data,t),busy:view.busy,
            setUI:setUIFn,navigate:navigateFn,openDialog:dialog=>dialog.kind==='prepare'?createTicket():setUIFn({dialog,dialogError:null,error:null,notice:null}),
            createTicket,creatingTicket,recreateDraft:ticket=>createDraftConversation(scope.workspaceId,locale.language,ticket.id,sessionId,sink),
            act:(name,args)=>act(scope.workspaceId,name,args,t,sink),refresh:()=>requestView(scope.workspaceId,true),
            onDraftDirtyChange:draftDirtyTracker(scope.workspaceId,sessionId,()=>pane.ui.ticketId),
            surface:'side-pane'
          })]);
        }
        const draftInject=sessionId=>({sessionId,hooks:{...inject().hooks,fleetDrafts:draftClient}});
        ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:DRAFT_TYPE,locale:NS,inject:draftInject},DraftPane));
      }
      /* Per-Session Fleet tab: renders the same shared Dashboard surface as the
         fullscreen panel (same components, controls and responsive container-query
         layout), opening on the Ticket page bound to this Session. ui state is
         per-Session; the Workspace data cache and polling stay shared. */
      const EMPTY_VIEW={data:{ready:false,pending:false,error:null,tickets:[],catalog:{}},ui:{},busy:false};
      function FleetSessionView({sessionId,useFleetLanguage,useFleetViews,useFleetModes,useFleetWorkspaces,useFleetSessions}) {
        const locale=useFleetLanguage(value=>value),t=fleetTranslator(locale.language);
        useFleetViews(value=>value);
        const mode=useFleetModes(value=>value),workspaces=useFleetWorkspaces(value=>value.items),sessionMap=useFleetSessions(value=>value.byId);
        const workspace=workspaces.find(item=>item.sessionIds?.includes(sessionId));
        const enabled=!!workspace&&mode.ready&&mode.enabledWorkspaceIds.includes(workspace.workspaceId);
        const scope=tabScope(sessionId,workspace?.workspaceId??null);
        const view=workspace?viewFor(workspace.workspaceId):EMPTY_VIEW;
        React.useEffect(()=>{tabMounts.add(sessionId);return()=>{tabMounts.delete(sessionId);};},[sessionId]);
        React.useEffect(()=>{
          if(!enabled||!workspace)return;
          void requestView(workspace.workspaceId);
          const timer=setInterval(()=>{if(!disposed&&!globalThis.document?.hidden&&!viewFor(workspace.workspaceId).busy)void requestView(workspace.workspaceId);},4000);
          timer.unref?.();
          return()=>clearInterval(timer);
        },[enabled,workspace?.workspaceId]);
        // Wait for a related Ticket even if the initial cache is ready but stale.
        // A successful pin or explicit navigation settles the choice for this Tab.
        if(enabled&&view.data.ready&&!scope.ui.initialized){
          const bound=view.data.tickets.map(ticket=>isIncompatibleDraft(ticket)?ticket:projectTicket(ticket))
            .filter(ticket=>ticket.originSessionId===sessionId||Object.values(ticket.execution?.nodes??{}).some(node=>(node.attempts??[]).some(attempt=>attempt.sessionId===sessionId))||Object.values(ticket.execution?.gates??{}).some(gate=>[gate,...(gate.history??[])].some(cycle=>cycle.dispatch?.sessionId===sessionId)))
            .filter(ticket=>!isIncompatibleDraft(ticket));
          const pick=bound.filter(ticket=>ticket.status==='running').at(-1)??[...bound].sort((a,b)=>String(b.updatedAt??'').localeCompare(String(a.updatedAt??'')))[0]??null;
          if(pick)scope.ui={...scope.ui,initialized:true,page:'ticket',ticketId:pick.id,nodeId:null};
        }
        const ui=scope.ui;
        const members=(workspace?.sessionIds??[]).filter(sid=>sessionMap[sid]);
        const openChat=async sid=>{try{if(sid)await ctx.uiWorkspace.openSession(sid);else if(workspace)await ctx.uiWorkspace.openWorkspace(workspace.workspaceId);}catch(error){setScopeUI(sessionId,{error:fleetErrorRecord(error)});}};
        const setUIFn=patch=>setScopeUI(sessionId,patch);
        const sink={get:()=>scope.ui,patch:setUIFn};
        const navigateFn=(page,patch={})=>page==='ticket'?navigateScopeTicket(sessionId,workspace?.workspaceId,patch.ticketId):setUIFn({page,error:null,notice:null,dialog:null,...patch});
        const createTicket=()=>workspace&&createDraftConversation(workspace.workspaceId,locale.language,null,sessionId,sink);
        const openWorkspaceDashboard=()=>{
          if(!workspace)return;
          selectWorkspace(workspace.workspaceId);
          setUI(workspace.workspaceId,{page:ui.page,scheduleId:ui.scheduleId??null,ticketId:ui.page==='ticket'?ui.ticketId??null:null,nodeId:ui.nodeId??null,agentId:ui.agentId??null,flowId:ui.flowId??null,query:ui.query??'',filter:ui.filter??'all',error:null,notice:null,dialog:null});
        };
        return h('section',{className:'dsh-fleet-shell','data-fleet-session-view':sessionId,'data-fleet-surface':'session-tab',lang:locale.language==='zh'?'zh-CN':'en'},h('style',null,fleetStyles),views.renderDashboard({
          t,...locale,setLanguagePreference:languageStore.setPreference,workspace,mode:localizeError(mode,t),enabled,members,sessionMap,openChat,
          ui:{...localizeError(ui,t),dialogError:fleetErrorText(ui.dialogError,t),notice:ui.notice?t(ui.notice):null},data:localizeError(view.data,t),busy:view.busy,
          setUI:setUIFn,navigate:navigateFn,openDialog:dialog=>dialog.kind==='prepare'?createTicket():setUIFn({dialog,dialogError:null,error:null,notice:null}),createTicket,creatingTicket,recreateDraft:ticket=>workspace&&createDraftConversation(workspace.workspaceId,locale.language,ticket.id,sessionId,sink),
          act:(name,args)=>workspace?act(workspace.workspaceId,name,args,t,sink):null,refresh:()=>workspace&&requestView(workspace.workspaceId),
          onDraftDirtyChange:workspace?draftDirtyTracker(workspace.workspaceId,sessionId,()=>scope.ui.ticketId):undefined,
          surface:'session-tab',openWorkspaceDashboard
        }));
      }

      /* Per-Session Fleet tab. Slot-only registration (the native strip derives
         from conversation.view entries; dsh-context uses the same pattern). Own
         unique id `oh-my-dsh-fleet` so it never collides with another plugin's
         tab; an optional tab must never crash the whole web boot. */
      try {
        ctx.slots.inject('conversation.view',()=>ctx.slots.register({name:'conversation.view',id:'oh-my-dsh-fleet',order:40,locale:NS,label:()=>fleetTranslator(languageStore.getSnapshot().language)('panel'),inject:sessionId=>({sessionId,hooks:{...inject().hooks,fleetDrafts:draftClient}})},FleetSessionView));
      } catch (error) { console.error('[fleet] conversation view registration failed', error); }
      ctx.slots.inject('main',function*(){yield ctx.slots.register({name:'main',key:CONTROL_ID,locale:NS,inject},ControlPanel);yield ctx.slots.register({name:'main',key:PANEL_ID,locale:NS,inject},FleetPanel);});
      ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:CONTROL_ID,order:-1000,locale:NS,label:()=>ctx.locale.bind(NS)('control')},SidebarFleetIcon));
    }
  };
}
