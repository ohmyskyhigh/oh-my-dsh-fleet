/** Fleet-owned language preference; the Host locale and user content stay untouched. */
export const fleetLanguageStorageKey = 'dsh-fleet:language';
export const fleetDictionaries = {
  en: {
    control:'oh-my-dsh-fleet', console:'oh-my-dsh-fleet · Control center', registered:'Registered workspaces', enabledCount:'Enabled workspaces', available:'Available', modeOn:'Enabled', modeOff:'Not enabled', enable:'Enable', disable:'Disable', openFleet:'Open Dashboard', refresh:'Refresh', loading:'Loading workspace modes…', saving:'Saving…', retry:'Retry', empty:'No registered workspaces yet. Add one from the sidebar.', controlIntro:'Choose a workspace to view its Tickets, Agents and orchestration. Each workspace keeps its own tasks.', disabledTarget:'Fleet is not enabled for this workspace. Enable it from the control center.', toControl:'Control center', saved:'Workspace mode saved', actionSaved:'Changes saved',
    panel:'oh-my-dsh-fleet', preview:'Workspace', title:'oh-my-dsh-fleet Dashboard', sessions:'Workspace sessions', noSessions:'No sessions yet.', openSession:'Open chat', newSession:'New workspace chat', untitled:'New session', status:'Status', open:'Open oh-my-dsh-fleet for {name}', unavailable:'This workspace is no longer available. Choose another workspace.', returnToConversation:'Back to conversation', returnHint:'Return with the original Session and draft preserved.', viewDraftSection:'Ticket draft', viewOpenSidebar:'Open in sidebar', viewNoWorkspace:'This session does not belong to a Fleet-enabled workspace.', viewNoDraft:'No Ticket draft in this session yet.', viewNoDraftHint:'Send /fleet new <request> in the chat to create one; then edit and confirm it here.', viewExecution:'Execution', viewNoExecution:'No started Ticket is bound to this session yet.', viewOpenTicket:'Open Ticket page',
    requestFailed:'The operation could not be completed. Details: {detail}', invalidResponseVersion:'The Fleet response version is not supported. Refresh and try again.', invalidModesResponse:'Fleet returned an invalid workspace list. Refresh and try again.', invalidWorkspaceResponse:'Fleet returned data for an unexpected workspace. Refresh and try again.', invalidActionResponse:'Fleet returned an unexpected action result. Refresh and check the task status.', ticketConfigurationLocked:'Ticket configuration is locked. Your unsaved changes are retained; edit after the Ticket has fully stopped.'
  },
  zh: {
    control:'oh-my-dsh-fleet', console:'oh-my-dsh-fleet · 中控台', registered:'已注册工作区', enabledCount:'已开启工作区', available:'可开启', modeOn:'已开启', modeOff:'未开启', enable:'开启', disable:'关闭', openFleet:'进入工作区面板', refresh:'刷新', loading:'正在读取工作区状态…', saving:'正在保存…', retry:'重试', empty:'还没有注册工作区，请先从侧栏添加。', controlIntro:'选择工作区，查看任务、智能体与编排。每个工作区独立保存自己的任务。', disabledTarget:'此工作区尚未开启 Fleet，请从中控台开启。', toControl:'中控台', saved:'工作区模式已保存', actionSaved:'操作已保存',
    panel:'oh-my-dsh-fleet', preview:'工作区', title:'oh-my-dsh-fleet 工作区面板', sessions:'工作区会话', noSessions:'暂无会话。', openSession:'打开对话', newSession:'新建工作区对话', untitled:'新会话', status:'状态', open:'打开“{name}”的 oh-my-dsh-fleet', unavailable:'此工作区已不可用，请选择其他工作区。', returnToConversation:'返回对话', returnHint:'回到原来的会话，保留对话草稿。', viewDraftSection:'任务草稿', viewOpenSidebar:'在侧栏打开', viewNoWorkspace:'此会话不属于已启用 Fleet 的工作区。', viewNoDraft:'这个会话还没有任务草稿。', viewNoDraftHint:'在对话里发送 /fleet new <需求> 即创建草稿，随后在此编辑与确认。', viewExecution:'执行情况', viewNoExecution:'此会话暂无已启动的任务。', viewOpenTicket:'打开任务页',
    requestFailed:'操作未完成。详细信息：{detail}', invalidResponseVersion:'Fleet 响应版本不匹配，请刷新后重试。', invalidModesResponse:'Fleet 返回的工作区列表有误，请刷新后重试。', invalidWorkspaceResponse:'Fleet 返回的工作区数据不匹配，请刷新后重试。', invalidActionResponse:'Fleet 返回的操作结果不匹配，请刷新并核对任务状态。', ticketConfigurationLocked:'任务配置已锁定。本地未保存修改已保留，请等待任务完全停止后再编辑。'
  }
};
export function fleetTranslator(language) {
  const dictionary = fleetDictionaries[language === 'zh' ? 'zh' : 'en'];
  return (key, parameters = {}) => (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(parameters,name) ? String(parameters[name]) : match);
}
export function fleetResponseError(key) { return Object.assign(new Error(key), {fleetMessageKey:key}); }
export function fleetErrorRecord(error) { return error?.fleetMessageKey ? {key:error.fleetMessageKey} : {key:'requestFailed',detail:String(error?.message ?? error)}; }
export function fleetErrorText(error,t) { return !error ? null : typeof error==='string' ? error : t(error.key,{detail:error.detail??''}); }
export function createFleetLanguage(hostLocale, {storage=()=>globalThis.localStorage,events=globalThis.window}={}) {
  const valid=value=>value==='zh'||value==='en'?value:'auto';
  const read=()=>{try{return valid(storage()?.getItem(fleetLanguageStorageKey));}catch{return 'auto';}};
  let preference=read(),disposed=false;
  const listeners=new Set();
  const hostLanguage=()=>{
    const active=hostLocale?.getSnapshot?.().active;
    const fallback=typeof window==='undefined'?'en':globalThis.navigator?.language;
    return /^zh(?:[-_]|$)/i.test(active||fallback||'en')?'zh':'en';
  };
  const state=()=>Object.freeze({languagePreference:preference,language:preference==='auto'?hostLanguage():preference});
  let snapshot=state();
  const publish=()=>{
    if(disposed)return;
    const next=state();
    if(next.languagePreference===snapshot.languagePreference&&next.language===snapshot.language)return;
    snapshot=next;for(const listener of [...listeners])listener();
  };
  const unsubscribe=hostLocale?.subscribe?.(publish);
  const onStorage=event=>{
    if(event.key!==fleetLanguageStorageKey&&event.key!==null)return;
    try{if(event.storageArea&&event.storageArea!==storage())return;}catch{return;}
    preference=event.key===null?'auto':valid(event.newValue);publish();
  };
  events?.addEventListener?.('storage',onStorage);
  return {
    getSnapshot:()=>snapshot,
    subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
    setPreference(value){
      if(disposed||!['auto','zh','en'].includes(value))return;
      preference=value;
      try{if(value==='auto')storage()?.removeItem(fleetLanguageStorageKey);else storage()?.setItem(fleetLanguageStorageKey,value);}catch{/* Keep the current in-memory choice when browser storage is unavailable. */}
      publish();
    },
    dispose(){if(disposed)return;disposed=true;unsubscribe?.();events?.removeEventListener?.('storage',onStorage);listeners.clear();}
  };
}
