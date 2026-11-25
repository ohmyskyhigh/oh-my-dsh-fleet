import { projectTicket, validatePlan, graphLevels, isIncompatibleDraft, isCurrentPlan, readableTitle, stagePlanView, effectiveSeriesTiming, isUtcInstant, seriesRecurrence, seriesScheduledAt, orchestrationContentFromPlan } from './fleet-model.js';

import { TICKET_STATUSES } from './fleet-model.js';

/** Absolute host file target for the native /api/file route; null when unsafe/unknown so we never render a fake link. */
export function workspaceFileTarget(workspacePath, relativePath) {
  if (typeof workspacePath !== 'string' || !workspacePath.trim() || typeof relativePath !== 'string' || !relativePath.trim()) return null;
  const rel = relativePath.replace(/\\/g, '/');
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').some(part => part === '..') || /[\u0000-\u001f\u007f]/u.test(rel)) return null;
  return `${workspacePath.replace(/[\\/]+$/, '').replace(/\\/g, '/')}/${rel}`;
}
export const fileHref = absolutePath => `api/file?path=${encodeURIComponent(absolutePath)}`;
const cleanList = value => Array.isArray(value) ? value.filter(v => typeof v === 'string' && v.trim()) : [];
/** Delivery gaps & override eligibility (P-45/P-46): override only at the settlement edge, never mid-run. */
export function deliveryGapInfo(ticket) {
  const deliverables = Array.isArray(ticket?.deliverables) ? ticket.deliverables : [];
  const gates = Array.isArray(ticket?.gates) ? ticket.gates : [];
  const nodes = Array.isArray(ticket?.nodes) ? ticket.nodes : [];
  const unbound = deliverables.filter(d => !d.artifactId && d.reviewStatus !== 'skipped').map(d => ({ index: d.index, label: d.label }));
  const staleGates = gates.filter(g => g.coverage === 'stale').map(g => g.id);
  const pendingExport = Boolean(ticket?.delivery?.pending);
  const allCompleted = nodes.length > 0 && nodes.every(n => ['completed','skipped'].includes(n.status));
  const allPassed = gates.every(g => ['passed','skipped'].includes(g.status));
  const blocked = !ticket?.delivery?.override && (unbound.length > 0 || staleGates.length > 0 || pendingExport);
  const canOverride = ticket?.status === 'running' && allCompleted && allPassed && blocked;
  return { unbound, staleGates, pendingExport, allCompleted, allPassed, blocked, canOverride };
}
const referenceKeys = ['ticketDependencies', 'ticketDependencySeries'];
const readReferences = owner => Object.fromEntries(referenceKeys.map(key => [key, [...(owner?.[key] ?? [])]]));
const planHasSeries = plan => [plan, ...(plan?.nodes ?? [])].some(owner => owner?.ticketDependencySeries?.length);
function routingFields(plan) {
  return {
    ...readReferences(plan),
    nodes: (plan.nodes ?? []).map(node => ({id:node.id, ...readReferences(node)})),
    gates: (plan.logicGates ?? []).map(gate => ({...gate, routes:gate.routes.map(route => ({...route,
      path:route.condition.path.join('\n'), operator:route.condition.operator, operand:JSON.stringify(route.condition.value) ?? ''}))})),
    bindings: (plan.deliverables ?? []).map(item => item?.whenNodeRuns ?? '')
  };
}
function writeReferenceFields(owner, fields) {
  for (const key of referenceKeys) {
    if (fields[key].length) owner[key] = [...fields[key]];
    else delete owner[key];
  }
}
function applyRouting(plan, fields, L) {
  const next = structuredClone(plan);
  writeReferenceFields(next, fields);
  for (const node of next.nodes ?? []) {
    const references = fields.nodes.find(item => item.id === node.id);
    if (references) writeReferenceFields(node, references);
  }
  if (fields.gates.length) next.logicGates = fields.gates.map(gate => ({id:gate.id,from:gate.from,routes:gate.routes.map(route => {
    const prior = route.condition;
    const path = prior?.path.join('\n') === route.path ? prior.path : route.path.split('\n');
    const condition = {path,operator:route.operator};
    if (route.operator === 'exists' && prior?.operator === 'exists' && Object.hasOwn(prior,'value')) condition.value = prior.value;
    if (route.operator !== 'exists') {
      try {
        condition.value = JSON.parse(route.operand);
        if (condition.value !== null && typeof condition.value === 'object' || typeof condition.value === 'number' && !Number.isFinite(condition.value)) throw new Error();
      } catch { throw new Error(L(`路线 ${route.id} 的比较值须为 JSON 字符串、数字、布尔值或 null。`,`Enter a JSON string, number, boolean or null for route ${route.id}.`)); }
    }
    return {id:route.id,to:route.to,condition};
  })}));
  else delete next.logicGates;
  for (const [index, binding] of fields.bindings.entries()) {
    const item = next.deliverables[index];
    if (binding) next.deliverables[index] = {...(typeof item === 'string' ? {text:item} : item), whenNodeRuns:binding};
    else if (item && typeof item === 'object') delete item.whenNodeRuns;
  }
  return next;
}
/** Pure draft structural edits (P-44/P-46/P-47); produce save-valid plans, never write back. */
export function applyGatePolicy(plan, gateId, { requireEvidence, rework }) {
  const next = structuredClone(plan);
  const gate = (next.gates ?? []).find(g => g.id === gateId);
  if (!gate) throw new Error(`Unknown gate: ${gateId}`);
  if (requireEvidence) gate.requireEvidence = true; else delete gate.requireEvidence;
  if (rework) {
    if (!Number.isSafeInteger(rework.maxRounds) || rework.maxRounds < 0) throw new Error('rework.maxRounds must be a safe integer >= 0');
    const nodeIds = new Set((next.nodes ?? []).map(n => n.id));
    const targets = cleanList(rework.targetNodes);
    if (targets.some(id => !nodeIds.has(id))) throw new Error('rework.targetNodes must reference plan nodes');
    if (rework.reworkSession !== undefined && !['reuse', 'new'].includes(rework.reworkSession)) throw new Error('rework.reworkSession must be "reuse" or "new"');
    gate.rework = { maxRounds: rework.maxRounds, ...(targets.length ? { targetNodes: targets } : {}), ...(typeof rework.scopeNote === 'string' && rework.scopeNote.trim() ? { scopeNote: rework.scopeNote.trim() } : {}), ...(rework.reworkSession === 'new' ? { reworkSession: 'new' } : {}) };
  } else delete gate.rework;
  return next;
}
export function applyTaskContract(plan, nodeId, contract) {
  const next = structuredClone(plan);
  const node = (next.nodes ?? []).find(n => n.id === nodeId);
  if (!node) throw new Error(`Unknown node: ${nodeId}`);
  const acceptance = cleanList(contract?.acceptance), verify = cleanList(contract?.verify);
  const scopeIn = cleanList(contract?.scope?.in), scopeOut = cleanList(contract?.scope?.out);
  const scope = (scopeIn.length || scopeOut.length) ? { ...(scopeIn.length ? { in: scopeIn } : {}), ...(scopeOut.length ? { out: scopeOut } : {}) } : undefined;
  if (!acceptance.length && !verify.length && !scope) delete node.task.contract;
  else node.task = { ...node.task, contract: { ...(acceptance.length ? { acceptance } : {}), ...(scope ? { scope } : {}), ...(verify.length ? { verify } : {}) } };
  return next;
}
export function applyDeliveryTarget(plan, value) {
  const next = structuredClone(plan);
  next.inputs = { ...(next.inputs ?? {}) };
  if (typeof value === 'string' && value.trim()) next.inputs.deliveryTarget = value.trim(); else delete next.inputs.deliveryTarget;
  return next;
}
/** P-49 one-sentence human task statement; empty removes it. */
export function applyTaskSummary(plan, nodeId, summary) {
  const next = structuredClone(plan);
  const node = (next.nodes ?? []).find(n => n.id === nodeId);
  if (!node) throw new Error(`Unknown node: ${nodeId}`);
  node.task = { ...(node.task ?? {}) };
  if (typeof summary === 'string' && summary.trim()) node.task.summary = summary.trim(); else delete node.task.summary;
  return next;
}
const validSelection = selection => {
  if (selection === null || selection === undefined) return null;
  if (typeof selection !== 'object' || Array.isArray(selection)) throw new Error('modelSelection must be an object or null');
  if (typeof selection.provider !== 'string' || !selection.provider.trim() || typeof selection.model !== 'string' || !selection.model.trim()) throw new Error('modelSelection needs provider and model');
  return { provider: selection.provider.trim(), model: selection.model.trim(), ...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort.trim() ? { reasoningEffort: selection.reasoningEffort.trim() } : {}) };
};
/** P-50 node-level override; null clears back to inheritance. */
function applyGateModelSelection(plan, gateId, selection) {
  const next=structuredClone(plan), gate=next.gates.find(item=>item.id===gateId);
  if(selection)gate.modelSelection=validSelection(selection);
  else delete gate.modelSelection;
  return next;
}
export function applyNodeModelSelection(plan, nodeId, selection) {
  const next = structuredClone(plan);
  const node = (next.nodes ?? []).find(n => n.id === nodeId);
  if (!node) throw new Error(`Unknown node: ${nodeId}`);
  const value = validSelection(selection);
  if (value) node.modelSelection = value; else delete node.modelSelection;
  return next;
}
/** P-50 agent-level selection; null clears back to the host default. */
export function applyAgentModelSelection(plan, agentId, selection) {
  const next = structuredClone(plan);
  const agent = next.agents?.[agentId];
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  const value = validSelection(selection);
  agent.profile = { ...(agent.profile ?? {}) };
  if (value) agent.profile.modelSelection = value; else delete agent.profile.modelSelection;
  return next;
}
/** P-48 per-deliverable criteria; editing a legacy string item converts that item only. */
export function applyDeliverableCriteria(plan, index, criteria) {
  const next = structuredClone(plan);
  const items = next.deliverables ?? [];
  if (!Number.isSafeInteger(index) || index < 0 || index >= items.length) throw new Error(`Unknown deliverable index: ${index}`);
  const clean = cleanList(criteria);
  const item = items[index];
  if (typeof item === 'string') items[index] = { text: item, ...(clean.length ? { criteria: clean } : {}) };
  else if (clean.length) items[index] = { ...item, criteria: clean };
  else { const { criteria: _drop, ...rest } = item; items[index] = rest; }
  return next;
}

/** Read-only projections never become save payloads. DSH owns Workspace, Session and Chat. */
export function createFleetViews(React) {
  const h = React.createElement;
  const json = value => JSON.stringify(value ?? {}, null, 2);
  const list = value => Array.isArray(value) ? value : [];
  const text = value => typeof value === 'string' ? value : json(value);
  const tones = {running:'running',draft:'neutral',pending:'waiting','stop-requested':'waiting',stopped:'neutral',delivered:'success',completed:'success',passed:'success',returned:'danger',failed:'danger',interrupted:'danger',cancelled:'neutral'};
  const names = {skipped:['已跳过','Skipped'],matched:['已命中','Matched'],superseded:['已替代','Superseded'],draft:['草稿','Draft'],running:['执行中','Running'],'stop-requested':['正在停止','Stopping'],stopped:['已停止','Stopped'],delivered:['已交付','Delivered'],pending:['待执行','Pending'],completed:['已完成','Completed'],passed:['已通过','Passed'],returned:['已退回','Returned'],failed:['执行失败','Failed'],interrupted:['待核对','Interrupted'],cancelled:['已取消','Cancelled']};
  const button = (label, onClick, props = {}) => h('button',{type:'button',className:'fl-btn',onClick,...props},label);
  const badge = (label, tone='neutral') => h('span',{className:'fl-badge','data-tone':tone},label);
  const status = (value,L) => badge(names[value] ? L(...names[value]) : value,tones[value]);
  const row = (...children) => h('div',{className:'fl-row'},...children);
  const empty = (message,action) => h('div',{className:'fl-empty'},h('p',null,message),action);
  const kv = (label,value) => h('div',{className:'fl-kv',key:label},h('span',null,label),h('span',null,value));
  const details = (label,value) => h('details',null,h('summary',null,label),h('pre',null,json(value)));
  // Long free-form agent text must not flood the thread; clamp to a preview with a disclosure (user decision 2026-11-19).
  const clampText = (value,marker) => {
    const s = typeof value==='string'?value:json(value);
    if (s.length<=260 && !s.includes('\n')) return h('p',{...marker},s);
    const preview = `${s.replace(/\s+/g,' ').trimStart().slice(0,110)}…`;
    return h('details',{className:'fl-clamp',...marker},h('summary',{className:'fl-small'},preview),h('p',{className:'fl-pre-wrap'},s));
  };
  const readValue=value=>Array.isArray(value)?h('ul',null,...value.map((item,i)=>h('li',{key:i},readValue(item)))):value&&typeof value==='object'?h('dl',{className:'fl-read-values'},...Object.entries(value).map(([key,item])=>h('div',{key},h('dt',null,key),h('dd',null,readValue(item))))):String(value??'—');
  const icon = name => h('span',{'aria-hidden':true},({plus:'＋',back:'←',arrow:'↗',refresh:'↻',flow:'◇',agent:'◈',chat:'↗'})[name] || name);
  const language = options => (cn,en) => options.language === 'zh' ? cn : en;
  const hasIssues = ticket => !ticket.abandonedAt && (list(ticket.nodes).some(n=>['failed','interrupted'].includes(n.status)) || list(ticket.gates).some(g=>g.status==='returned'));
  const reviewSources=(ticket,gate)=>list(gate?.from).map(id=>list(ticket.nodes).find(n=>n.id===id));
  const sourcesReady=(ticket,gate)=>{const sources=reviewSources(ticket,gate);return sources.some(n=>n?.status==='completed')&&sources.every(n=>['completed','skipped'].includes(n?.status));};
  const reviewSourceArtifacts=(ticket,gate)=>{const ids=reviewSources(ticket,gate).filter(n=>n?.status==='completed').map(n=>n.id);return Object.entries(ticket.artifacts||{}).filter(([,artifact])=>ids.includes(artifact.nodeId)&&list(artifact.versions).length);};
  const waiting = ticket => {
    if (ticket.status !== 'running' || ticket.abandonedAt) return [];
    return list(ticket.gates).filter(g=>g.status==='pending' && sourcesReady(ticket,g));
  };
  const timestamp = (value,L) => value ? new Date(value).toLocaleString(L('zh-CN','en'), {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
  // P-44～P-47 derived display helpers. Projections only; nothing here writes back.
  const shortHash = value => typeof value === 'string' && value.length > 8 ? `${value.slice(0,8)}…` : (value || '—');
  const coverageNames = {covered:['已审核','Reviewed'],stale:['待复核','Re-review needed'],unreviewed:['未审核','Not reviewed'],'not-passed':['未通过','Not passed']};
  const coverageTones = {covered:'success',stale:'danger',unreviewed:'neutral','not-passed':'neutral'};
  const deliverableStatusNames = {skipped:['已跳过','Skipped'],unbound:['未绑定','Unbound'],unreviewed:['未审核','Not reviewed'],covered:['已审核','Reviewed'],stale:['待复核','Re-review needed']};
  const deliverableStatusTones = {unbound:'neutral',unreviewed:'neutral',covered:'success',stale:'danger'};
  const staleAlert = L => h('p',{className:'fl-notice fl-small',role:'alert'},L('产物已更新，审核结论未覆盖最新版本','The artifact has been updated; the review verdict does not cover the latest version.'));
  // Native /api/file anchor (same-origin auth as /api/fleet/*); never a fake link when the target is unknown.
  const fileLink = (o,absolutePath,label,props={}) => absolutePath ? h('a',{href:fileHref(absolutePath),target:'_blank',rel:'noopener noreferrer',className:'fl-btn fl-btn-ghost',...props},label) : null;
  const snapshotTarget = (o,relativePath) => workspaceFileTarget(o.workspace?.path,relativePath);
  const acceptanceNames = {passed:['通过','Passed'],failed:['未通过','Failed'],unknown:['未知','Unknown']};
  const acceptanceTones = {passed:'success',failed:'danger',unknown:'waiting'};
  const severityNames = {low:['低','Low'],medium:['中','Medium'],high:['高','High'],blocker:['阻断','Blocker']};
  const severityTones = {low:'neutral',medium:'waiting',high:'danger',blocker:'danger'};
  const evidenceList = (label,items,mono) => list(items).length ? h('div',{className:'fl-spaced'},h('p',{className:'fl-small fl-muted'},label),h('ul',{className:mono?'fl-mono':undefined},...list(items).map((item,i)=>h('li',{key:i},item)))) : null;
  // P-48/P-49/P-50 display helpers. Projections only; nothing here writes back.
  const firstSentence = value => String(value||'').split(/[。．!！?？;；\n]/)[0].trim();
  const modelSourceNames = {node:['节点覆盖','Node override'],agent:['Agent 配置','Agent profile'],default:['宿主默认','Host default']};
  const modelDisplay = (o,node,agents,L) => {
    const nodeSel = node?.modelSelection, agentSel = agents?.[node?.agentId]?.profile?.modelSelection;
    const sel = nodeSel || agentSel || null;
    const cat = o.data?.catalog?.modelCatalog ?? o.catalog?.modelCatalog;
    const eff = sel || cat?.default || null;
    const source = nodeSel ? 'node' : agentSel ? 'agent' : 'default';
    if (!eff) return { text: L('宿主默认（目录不可用）','Host default (catalog unavailable)'), effort: null, source, configured: false };
    const model = list(list(cat?.groups).find(g=>g.id===eff.provider)?.models).find(m=>m.id===eff.model);
    return { text: model?.name || eff.model, effort: eff.reasoningEffort || model?.reasoning?.defaultEffort || null, source, configured: Boolean(sel), provider: eff.provider, modelId: eff.model };
  };
  const modelLine = (o,node,agents,L) => { const m=modelDisplay(o,node,agents,L);
    return h('span',{className:'fl-row fl-small fl-muted fl-model','data-fleet-node-model':node?.id},h('span',{className:'fl-mono'},m.text),m.effort?badge(m.effort,'neutral'):null,!m.configured?h('span',null,L('默认','default')):null); };
  // P-62 orchestration plan: stage goal/tasks/outcomes plus the declared tool/plugin/skill use.
  const capabilityKindNames = {tool:['工具','Tools'],plugin:['插件','Plugins'],skill:['技能','Skills']};
  const outcomeKindNames = {deliverable:['交付物','Deliverable'],event:['事件','Event']};
  const planChips = (task,L) => {
    const caps=list(stagePlanView(task).capabilities).filter(capability=>capability.name||capability.id);
    if(!caps.length)return null;
    const shown=caps.slice(0,3),kindLabels={tool:L('工具','Tool'),plugin:L('插件','Plugin'),skill:L('技能','Skill')};
    return h('span',{className:'fl-row fl-plan-chips','data-fleet-node-capabilities':''},
      ...shown.map((capability,index)=>h('span',{key:index,className:'fl-chip fl-small','data-fleet-chip-kind':capability.kind,title:`${kindLabels[capability.kind]} · ${capability.name||capability.id}`},capability.name||capability.id)),
      caps.length>shown.length?h('span',{className:'fl-small fl-muted'},`+${caps.length-shown.length}`):null);
  };
  function gatePlanSections(gate,node,agents,o,controls={}) {
    const L=o.L||language(o), task=gate.reviewTask||{};
    const selection=gate.modelSelection;
    const hasOverride=typeof selection?.provider==='string'&&typeof selection?.model==='string';
    const model=modelDisplay(o,hasOverride?{...node,modelSelection:selection}:node,agents,L);
    const ownCaps=Array.isArray(gate.plannedCapabilities);
    const caps=stagePlanView({plannedCapabilities:ownCaps?gate.plannedCapabilities:node?.task?.plannedCapabilities}).capabilities;
    const inputs=cleanList(task.inputs),checks=cleanList(task.checks);
    const summary=typeof task.summary==='string'?task.summary:null;
    const scopeNote=typeof gate.rework?.scopeNote==='string'?gate.rework.scopeNote:null;
    const section=(id,title,...children)=>h('section',{className:'fl-plan-block','data-fleet-review-section':id},h('h3',null,title),...children);
    const items=entries=>h('ul',{className:'fl-plan-list'},...entries.map((value,index)=>h('li',{key:index},value)));
    const note=value=>h('p',{className:'fl-help'},value);
    const source=hasOverride?L('此 Gate 专用','Gate override'):model.source==='node'?L(`继承审核节点 ${node.id}`,`Inherited from reviewer node ${node.id}`):L(...modelSourceNames[model.source]);
    const renderCapabilities=kind=>{
      const group=list(caps).filter(cap=>cap.kind===kind);
      if(!group.length)return null;
      const entries=group.map(cap=>h(React.Fragment,null,
        h('strong',null,cap.name||cap.id),
        cap.name&&cap.name!==cap.id&&` (${cap.id})`,
        cap.purpose&&` · ${cap.purpose}`,
        cap.tools.length>0&&h('p',{className:'fl-small'},cap.tools.join(' · '))));
      return h('div',{className:'fl-plan-group',key:kind,'data-fleet-capability-group':kind},h('h4',null,L(...capabilityKindNames[kind])),items(entries));
    };
    return h('div',{className:'fl-plan','data-fleet-gate-plan':gate.id},
      !controls.compact&&section('executor',L('执行者与模型','Reviewer and model'),
        kv(L('执行者','Reviewer'),node?`${agents?.[node.agentId]?.name||node.agentId||'—'} · ${node.id}`:L(`审核节点缺失 · ${gate.reviewer.nodeId}`,`Missing reviewer node · ${gate.reviewer.nodeId}`)),
        kv(L('模型','Model'),[model.provider,model.text,model.effort,source].filter(Boolean).join(' · ')),controls.model),
      section('inputs',L('审核输入','Review inputs'),
        !controls.compact&&summary&&h('p',{className:'fl-plan-goal'},summary),
        h('p',{className:'fl-small fl-muted'},L('来源节点','Source nodes')+' · '+(list(gate.from).join(' · ')||'—')),
        controls.artifacts,
        inputs.length?items(inputs):note(L('未单列输入材料','No input materials specified')),controls.inputs),
      section('checks',L('检查项','Checks'),
        checks.length?items(checks):scopeNote?h(React.Fragment,null,note(L('来自此 Gate 的返工范围说明','From this gate’s rework scope note')),h('p',{className:'fl-pre-wrap'},scopeNote)):note(L('此 Gate 未单列检查项','No checks specified for this gate')),controls.checks),
      section('dependencies',L('计划使用','Planned use'),
        note(ownCaps?L('此 Gate 专用','Gate-specific dependencies'):L(`继承审核节点 ${gate.reviewer.nodeId}`,`Inherited from reviewer node ${gate.reviewer.nodeId}`)),
        h('div',{className:'fl-capability-block'},caps?.length?['tool','plugin','skill'].map(renderCapabilities):note(Array.isArray(caps)?L('无','None'):L('未记录','Not recorded'))),controls.dependencies));
  }
  const planOutcomeRow = (outcome,index,L,rows) => {
    const row=Number.isSafeInteger(outcome.deliverableIndex)?rows[outcome.deliverableIndex]:null;
    const fallback=outcome.deliverableIndex!==undefined?L(`交付物 #${outcome.deliverableIndex+1}`,`Deliverable #${outcome.deliverableIndex+1}`):L('未命名结果','Unnamed outcome');
    return h('li',{key:index,className:'fl-plan-outcome','data-fleet-outcome-kind':outcome.kind},
      h('div',{className:'fl-row'},badge(L(...outcomeKindNames[outcome.kind]),'neutral'),h('span',null,outcome.text||row?.label||fallback),row?.latest?badge(`v${row.latest.version}`,'success'):row?badge(L('待提交','Not submitted'),'neutral'):null));
  };
  function nodePlanSections(node,ticket,o) {
    const {L}=o, view=stagePlanView(node?.task), rows=list(ticket?.deliverables), historical=o.historical===true;
    const stage=view.stage, hasStage=Boolean(stage&&(stage.goal||stage.tasks.length||stage.outcomes.length)), caps=view.capabilities;
    const missingStage=historical?L('此轮冻结配置未记录阶段计划。','The frozen configuration for this round records no stage plan.'):L('尚未填写阶段计划 · 在对话里让 Agent 补齐','Stage plan not filled in yet — ask the Agent to complete it in the conversation');
    const missingCaps=historical?L('此轮冻结配置未记录 Tool／Plugin／Skill 声明。','The frozen configuration for this round declares no tools, plugins or skills.'):L('尚未声明将要使用的 Tool／Plugin／Skill · 在对话里让 Agent 补齐','Planned tools, plugins and skills are not declared yet — ask the Agent to complete them in the conversation');
    return h('div',{className:'fl-plan','data-fleet-node-plan':node?.id},
      h('section',{className:'fl-plan-block','data-fleet-stage-plan':node?.id},
        h('h3',null,L('阶段计划','Stage plan')),
        hasStage?h(React.Fragment,null,
          stage.goal?h('p',{className:'fl-plan-goal','data-fleet-stage-goal':node?.id},stage.goal):null,
          stage.tasks.length?h(React.Fragment,null,
            h('p',{className:'fl-small fl-muted'},L('要完成的任务','Tasks to complete')),
            h('ul',{className:'fl-plan-list'},...stage.tasks.map((task,index)=>h('li',{key:index},task)))):null,
          stage.outcomes.length?h(React.Fragment,null,
            h('p',{className:'fl-small fl-muted'},L('预期结果','Expected outcomes')),
            h('ul',{className:'fl-plan-list'},...stage.outcomes.map((outcome,index)=>planOutcomeRow(outcome,index,L,rows)))):null)
          :h('p',{className:'fl-help'},missingStage)),
      h('section',{className:'fl-plan-block','data-fleet-planned-use':node?.id},
        h('h3',null,L('计划使用','Planned use')),
        h('div',{className:'fl-capability-block','data-fleet-capability-block':node?.id},
        caps?null:h('p',{className:'fl-help'},missingCaps),
        ...['tool','plugin','skill'].map(kind=>{
          const items=list(caps).filter(capability=>capability.kind===kind);
          const label=L(...capabilityKindNames[kind]);
          return h('div',{className:'fl-plan-group',key:kind,'data-fleet-capability-group':kind},
            h('h4',{className:'fl-plan-group-title'},label,caps?h('span',{className:'fl-muted'},` ${items.length}`):null),
            items.length?h('ul',{className:'fl-plan-names',role:'list','aria-label':label},...items.map((capability,index)=>
              h('li',{key:index,'data-fleet-capability-kind':kind},capability.name||capability.id)))
              :h('p',{className:'fl-muted','data-fleet-capability-empty':kind},caps?L('无','None'):historical?L('此轮未记录','Not recorded'):L('未声明','Not declared')));
        }),
        caps?.length>0&&h('details',{className:'fl-plan-use-details','data-fleet-capability-details':node?.id},
          h('summary',null,L('查看用途','View purposes')),
          h('ul',{className:'fl-plan-list'},...caps.map((capability,index)=>h('li',{key:index},
            h('span',null,capability.name&&capability.name!==capability.id?`${capability.name} (${capability.id})`:capability.id),
            capability.kind==='skill'?h('span',{className:'fl-muted'},` · ${L('按需加载','Loaded on demand')}`):null,
            capability.purpose?h('span',{className:'fl-muted'},` · ${capability.purpose}`):null,
            capability.tools.length?h('p',{className:'fl-small fl-muted'},`${L('工具','Tools')} ${capability.tools.join(' · ')}`):null)))))));
  }
  // P-48 human layer + P-56 file manifest: description, expected files (planned/submitted/undetermined),
  // collapsed own criteria and collapsed agent spec. Legacy strings keep rendering their text unchanged.
  const categoryNames = {code:['代码交付','Code deliverable'],noncode:['非代码交付','Non-code deliverable'],other:['其他交付','Other deliverable']};
  const shortCategoryNames = {code:['代码','Code'],noncode:['非代码','Non-code'],other:['其他','Other']};
  const deliverableFileRow = (o,f,i,L) => h('li',{key:i,className:'fl-file','data-fleet-file-status':f.submitted?'submitted':f.path?'planned':'undetermined'},
    h('span',{className:'fl-file-purpose'},f.purpose||'—'),
    f.path?h('span',{className:'fl-mono fl-file-path',dir:'ltr'},f.path):h('span',{className:'fl-small fl-muted'},L('路径待定','Path TBD')),
    f.submitted?h('span',{className:'fl-row'},badge(`v${f.submitted.version}`,'success'),fileLink(o,snapshotTarget(o,f.submitted.snapshotPath),L('查看 ↗','Open ↗'),{'data-fleet-file-link':String(i)})):f.path?badge(L('待提交','Not submitted'),'neutral'):null);
  const deliverableFilesBlock = (item,o,L) => {
    const files=list(item.files);
    if(!files.length||!o)return null;
    const shown=files.slice(0,4),rest=files.slice(4);
    return h('div',{className:'fl-spaced','data-fleet-deliverable-files':item.index},
      h('p',{className:'fl-small fl-muted'},`${L('交付文件','Deliverable files')} · ${files.length}`),
      h('ul',{className:'fl-filelist'},...shown.map((f,i)=>deliverableFileRow(o,f,i,L))),
      rest.length?h('details',null,h('summary',null,L(`其余 ${rest.length} 项`,`+${rest.length} more`)),h('ul',{className:'fl-filelist'},...rest.map((f,i)=>deliverableFileRow(o,f,i+shown.length,L)))):null);
  };
  const deliverableHumanLayer = (item,L,o) => h(React.Fragment,null,
    item.description?h('p',{className:'fl-small fl-spaced'},item.description):null,
    deliverableFilesBlock(item,o,L),
    list(item.criteria).length?h('details',{className:'fl-spaced','data-fleet-deliverable-criteria':item.index},h('summary',null,`${L('验收标准','Acceptance criteria')} · ${list(item.criteria).length}`),h('ul',{className:'fl-critlist'},...list(item.criteria).map((c,i)=>h('li',{key:i},text(c))))):null,
    item.title&&item.spec?h('details',{className:'fl-spaced','data-fleet-deliverable-spec':item.index},h('summary',null,L('Agent 完整规格','Full agent spec')),h('pre',{className:'fl-mono fl-small'},item.spec)):null);
  // P-50 model/effort selects driven by the host catalog; form is {provider,model,reasoningEffort}.
  const modelSelects = (catalog,form,setForm,L,prefix='') => {
    const groups=list(catalog?.groups), group=groups.find(g=>g.id===form.provider), models=list(group?.models), model=models.find(m=>m.id===form.model), efforts=list(model?.reasoning?.efforts);
    return h('div',{className:'fl-stack'},
      h('label',{className:'fl-small'},L('Provider','Provider'),h('select',{className:'fl-input',name:`${prefix}provider`,value:form.provider,'data-fleet-model-provider':prefix||'node',onChange:e=>setForm({...form,provider:e.target.value,model:'',reasoningEffort:''})},h('option',{value:''},L('选择 provider','Select provider')),...groups.map(g=>h('option',{key:g.id,value:g.id},g.name||g.id)))),
      h('label',{className:'fl-small'},L('模型','Model'),h('select',{className:'fl-input',name:`${prefix}model`,value:form.model,disabled:!group,'data-fleet-model-name':prefix||'node',onChange:e=>setForm({...form,model:e.target.value,reasoningEffort:''})},h('option',{value:''},L('选择模型','Select model')),...models.map(m=>h('option',{key:m.id,value:m.id},m.name||m.id)))),
      h('label',{className:'fl-small'},L('Reasoning effort','Reasoning effort'),h('select',{className:'fl-input',name:`${prefix}effort`,value:form.reasoningEffort,disabled:!model||!efforts.length,'data-fleet-model-effort':prefix||'node',onChange:e=>setForm({...form,reasoningEffort:e.target.value})},h('option',{value:''},L('继承模型默认','Inherit model default')),...efforts.map(e=>h('option',{key:e.id,value:e.id},e.name||e.id)))));
  };
  function ModelFields({catalog,initial,L,prefix}) { const [form,setForm]=React.useState({provider:initial?.provider||'',model:initial?.model||'',reasoningEffort:initial?.reasoningEffort||''}); return modelSelects(catalog,form,setForm,L,prefix); }
  // Human override keeps authority but shows which artifact versions it targeted (P-45).
  const overrideBinding = (ticket,gate) => {
    const arts = Object.entries(ticket.artifacts ?? {}).filter(([,a])=>list(gate.from).includes(a.nodeId));
    if(!arts.length || !gate.humanOverride) return null;
    const at = String(gate.humanOverride.time ?? '');
    const bound = arts.map(([id,a])=>{ const v = list(a.versions).slice().reverse().find(v=>String(v.submittedAt ?? '') <= at); return v ? `${id} v${v.version}` : null; }).filter(Boolean);
    const latest = arts.map(([id,a])=>`${id} v${list(a.versions).at(-1)?.version ?? '?'}`).join(', ');
    return {bound:bound.join(', '),latest};
  };

  // ---- P-65～P-67 定时系列与模板实例化（0.9.5） ----
  // 日历计算、时区与 DST 归宿主 dsh-schedule；UI 只提交 ScheduleTiming 并按系列时区格式化宿主回声。
  const browserZone=()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}catch{return 'UTC';}};
  const zoneTimestamp=(value,timeZone,L)=>{
    if(!value)return '—';
    const date=new Date(value);
    if(Number.isNaN(date.getTime()))return String(value);
    try{return new Intl.DateTimeFormat(L('zh-CN','en'),{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:timeZone||undefined}).format(date);}
    catch{return date.toLocaleString(L('zh-CN','en'));}
  };
  const seriesZone=series=>{
    const timing=effectiveSeriesTiming(series),kind=timing?.kind;
    return series?.host?.timing?.timeZone || timing?.[kind]?.time_zone || (kind==='at' && series?.timing?.at?.time_zone) || browserZone();
  };
  const weekdayNames=L=>[L('周一','Mon'),L('周二','Tue'),L('周三','Wed'),L('周四','Thu'),L('周五','Fri'),L('周六','Sat'),L('周日','Sun')];
  const timingSummary=(series,L)=>{
    if(series.triggerSeriesId)return L(`跟随上游系列 ${series.triggerSeriesId}`,`Follows upstream series ${series.triggerSeriesId}`);
    const timing=effectiveSeriesTiming(series),kind=timing?.kind,zone=seriesZone(series),clock=value=>String(value||'').slice(0,5);
    if(kind==='daily')return `${L('每天','Daily')} ${clock(timing.daily.time)} · ${zone}`;
    if(kind==='weekly'){const days=list(timing.weekly.weekdays).map(d=>weekdayNames(L)[d-1]||d).join(L('、',', '));return `${L('每周','Weekly')} ${days} ${clock(timing.weekly.time)} · ${zone}`;}
    if(seriesRecurrence(series)==='once')return `${L('一次性','Once')} · ${zoneTimestamp(nextSeriesTime(series),zone,L)}`;
    if(kind==='rrule')return String(timing.rrule||'RRULE');
    if(kind==='cron')return `${timing.cron.expression||'cron'} · ${zone}`;
    if(kind==='every')return `${L('每','Every')} ${timing.every_seconds??'—'}s`;
    return L('时间规则未知','Unknown timing');
  };
  const seriesSource=series=>{
    if(!series?.sourceTemplateId&&series?.sourceTicketId)return {kind:'ticket',ticketId:series.sourceTicketId};
    const ref=list(series?.sourceRefs).find(item=>item?.kind==='orchestration');
    return ref?{kind:'template',templateId:ref.templateId,templateRevision:ref.templateRevision}:{kind:'unknown'};
  };
  const seriesStatusNames={active:['启用中','Active'],paused:['已暂停','Paused'],orphaned:['宿主任务已删除','Host task deleted'],ended:['已结束','Ended']};
  const seriesStatusTones={active:'success',paused:'waiting',orphaned:'danger',ended:'neutral'};
  const occurrenceStatusNames={waiting:['等待上游','Waiting for upstream'],started:['已建票','Started'],failed:['失败','Failed']};
  const scheduleUnavailableReason=(data,L)=>data?.series&&data.series.available===false?(data.series.unavailableReason||L('宿主定时服务（dsh-schedule）不可用，无法创建或管理计划。','The host schedule service (dsh-schedule) is unavailable; schedules cannot be created or managed.')):null;
  function ticketSeries(ticket,data) {
    const matches=list(data?.series?.items).flatMap(series=>{
      const occurrence=list(series.occurrences).find(item=>item.ticketId===ticket?.id);
      if(series.sourceTicketId!==ticket?.id&&!occurrence)return [];
      return [{seriesId:series.id,role:occurrence?'occurrence':'source',occurrenceAt:occurrence?.occurrenceAt,name:series.name,revision:series.revision,status:series.status,recurrence:seriesRecurrence(series),series}];
    });
    return matches.length?matches:ticket?.series?[ticket.series]:[];
  }
  function seriesBadges(ticket,data,L,onOpen,surface) {
    return ticketSeries(ticket,data).map(member=>h('div',{className:'fl-row fl-spaced',key:member.seriesId,[`data-fleet-${surface}-series`]:ticket.id},
      badge(`${L('系列','Series')} · ${member.name}`,'running'),
      member.occurrenceAt&&badge(`${L('预定','Scheduled')} ${zoneTimestamp(member.occurrenceAt,seriesZone(member.series),L)}`),
      onOpen&&button(L('查看计划','Open schedule'),()=>onOpen(member.seriesId),{className:'fl-btn fl-btn-ghost',[`data-fleet-${surface}-series-link`]:ticket.id})));
  }
  const needsSaveScope=info=>info?.recurrence==='recurring'&&['active','paused'].includes(info.status);
  function ScopePicker({choices,L,onChoose,busy}) {
    const [id,setId]=React.useState(choices.length===1?choices[0].seriesId:'');
    const selected=choices.find(item=>item.seriesId===id);
    return h('div',{className:'fl-notice fl-spaced','data-fleet-save-scope':''},
      h('strong',null,L('这次修改要应用到哪里？','Where should this change apply?')),
      choices.length>1&&h('label',{className:'fl-field'},L('目标系列','Target series'),h('select',{value:id,onChange:e=>setId(e.target.value),disabled:busy},h('option',{value:''},L('选择系列','Choose a series')),...choices.map(item=>h('option',{key:item.seriesId,value:item.seriesId},item.name)))),
      h('p',{className:'fl-help'},L('整个系列会将本次修改应用到当前 Ticket 和未来期次。','Entire series applies these edits to this Ticket and future occurrences.')),
      h('div',{className:'fl-row'},button(L('仅此 Ticket','This Ticket only'),()=>onChoose({scope:'ticket'}),{disabled:busy,'data-fleet-scope-ticket':''}),
        button(L('整个系列','Entire series'),()=>selected&&onChoose({scope:'series',seriesId:selected.seriesId,expectedSeriesRevision:selected.revision}),{disabled:busy||selected?.revision==null,'data-fleet-scope-series':''}),
        button(L('取消','Cancel'),()=>onChoose(null),{disabled:busy,'data-fleet-scope-cancel':''})));
  }
  const todayLocal=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
  const initialTimingState=(initial=null)=>({
    freq:initial?.kind==='daily'?'daily':initial?.kind==='weekly'?'weekly':'once',
    date:initial?.at&&typeof initial.at==='object'&&initial.at.date?initial.at.date:todayLocal(),
    time:String(initial?.daily?.time||initial?.weekly?.time||(initial?.at&&typeof initial.at==='object'?initial.at.time:'')||'09:00').slice(0,5),
    zone:initial?.daily?.time_zone||initial?.weekly?.time_zone||(initial?.at&&typeof initial.at==='object'?initial.at.time_zone:'')||browserZone(),
    days:list(initial?.weekly?.weekdays).length?[...initial.weekly.weekdays]:[1]
  });
  const buildTiming=(state,L)=>{
    const time=String(state.time||'').trim();
    if(!/^\d{2}:\d{2}$/.test(time))return {error:L('请填写有效钟点（HH:mm）。','Enter a valid time (HH:mm).')};
    const zone=String(state.zone||'').trim();
    if(!zone)return {error:L('请填写时区。','Enter a time zone.')};
    try{new Intl.DateTimeFormat('en',{timeZone:zone});}catch{return {error:L('时区无效，请使用 IANA 名称（如 Asia/Shanghai）。','Invalid time zone; use an IANA name such as Asia/Shanghai.')};}
    if(state.freq==='once'){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(state.date||''))return {error:L('请选择执行日期。','Choose a run date.')};
      return {timing:{kind:'at',at:{date:state.date,time:`${time}:00`,time_zone:zone}}};
    }
    if(state.freq==='daily')return {timing:{kind:'daily',daily:{time:`${time}:00`,time_zone:zone}}};
    if(!state.days.length)return {error:L('每周执行至少选择一天。','Pick at least one weekday.')};
    return {timing:{kind:'weekly',weekly:{time:`${time}:00`,time_zone:zone,weekdays:[...state.days].sort((a,b)=>a-b)}}};
  };
  function TimingFields({L,state,onChange,disabled}) {
    const zoneId=`fl-zone-${React.useId().replace(/[^\w-]/g,'')}`;
    const set=patch=>onChange({...state,...patch});
    const zones=[...new Set([browserZone(),'UTC','Asia/Shanghai','Asia/Tokyo','Asia/Singapore','Europe/London','Europe/Berlin','America/New_York','America/Los_Angeles','Australia/Sydney'])];
    return h('div',{className:'fl-stack','data-fleet-timing-fields':''},
      h('label',{className:'fl-field'},L('重复','Repeat'),
        h('select',{value:state.freq,disabled,'data-fleet-schedule-freq':'',onChange:e=>set({freq:e.target.value})},
          h('option',{value:'once'},L('一次性','Once')),h('option',{value:'daily'},L('每天','Daily')),h('option',{value:'weekly'},L('每周','Weekly')))),
      state.freq==='once'&&h('label',{className:'fl-field'},L('日期','Date'),h('input',{type:'date',value:state.date,disabled,'data-fleet-schedule-date':'',onChange:e=>set({date:e.target.value})})),
      h('label',{className:'fl-field'},L('钟点','Time'),h('input',{type:'time',value:state.time,disabled,required:true,'data-fleet-schedule-time':'',onChange:e=>set({time:e.target.value})})),
      h('label',{className:'fl-field'},L('时区（IANA）','Time zone (IANA)'),h('input',{value:state.zone,disabled,list:zoneId,required:true,'data-fleet-schedule-zone':'',onChange:e=>set({zone:e.target.value})}),h('datalist',{id:zoneId},...zones.map(z=>h('option',{key:z,value:z})))),
      state.freq==='weekly'&&h('div',{className:'fl-field'},h('span',null,L('每周执行日','Weekdays')),
        h('div',{className:'fl-row fl-weekdays',role:'group','aria-label':L('每周执行日','Weekdays')},...weekdayNames(L).map((label,i)=>{const day=i+1,on=state.days.includes(day);
          return h('button',{key:day,type:'button',className:'fl-btn','aria-pressed':on,disabled,'data-fleet-schedule-weekday':day,onClick:()=>set({days:on?state.days.filter(d=>d!==day):[...state.days,day]})},label);}))),
      h('p',{className:'fl-help'},L('重复按所选时区的固定钟点触发（夏令时随当地钟表）；下次执行时间以启用后宿主返回为准。','Recurring runs fire at the fixed wall-clock time in the chosen zone (DST follows the local clock); the next run time comes from the host after enabling.')));
  }
  const planFreezeSummary=(plan,L)=>h('div',{className:'fl-notice fl-spaced','data-fleet-schedule-summary':''},
    h('p',{className:'fl-small fl-muted'},L('启用时将冻结以下配置为系列配置：','Enabling freezes this configuration as the series configuration:')),
    kv(L('目标','Goal'),String(plan?.goal||'').slice(0,160)),
    ...list(plan?.nodes).map(node=>kv(`${node.id}${node.role?` · ${node.role}`:''}`,node.agentId||L('未分配','Unassigned'))),
    kv(L('交付物','Deliverables'),list(plan?.deliverables).map(item=>typeof item==='string'?item:item?.title||item?.text||'').join(' · ')||'—'));
  function ScheduleForm({L,initialName='',initialTiming=null,busy=false,error=null,unavailable=null,summary=null,onSubmit,onCancel,submitLabel}) {
    const [name,setName]=React.useState(initialName);
    const [timing,setTiming]=React.useState(()=>initialTimingState(initialTiming));
    const [localError,setLocalError]=React.useState(null);
    const [submitting,setSubmitting]=React.useState(false);
    const [done,setDone]=React.useState(null);
    const locked=busy||submitting||!!unavailable;
    async function submit(event){
      event.preventDefault();
      if(locked)return;
      const trimmed=name.trim();
      if(!trimmed||trimmed.length>120){setLocalError(L('名称需为 1–120 个字符。','Name must be 1–120 characters.'));return;}
      const built=buildTiming(timing,L);
      if(built.error){setLocalError(built.error);return;}
      setLocalError(null);setSubmitting(true);
      try{const result=await onSubmit({name:trimmed,timing:built.timing});if(result)setDone(result);}
      finally{setSubmitting(false);}
    }
    if(done)return h('div',{className:'fl-stack','data-fleet-schedule-created':''},
      h('p',{className:'fl-notice',role:'status'},L('计划已启用。','Schedule enabled.')),
      kv(L('下次执行','Next run'),zoneTimestamp(nextSeriesTime(done) ?? seriesScheduledAt({host:done}),timing.zone,L)),
      h('p',{className:'fl-help'},L('可在「计划」页查看期次记录、暂停或删除。','Manage occurrences, pause or delete on the Schedules page.')),
      h('div',{className:'fl-dialog-actions'},button(L('完成','Done'),onCancel,{className:'fl-btn fl-btn-primary','data-fleet-schedule-done':''})));
    return h('form',{onSubmit:submit,'data-fleet-schedule-form':''},h('div',{className:'fl-stack'},
      unavailable&&h('p',{className:'fl-notice',role:'alert','data-fleet-schedule-unavailable':''},unavailable),
      h('label',{className:'fl-field'},L('计划名称','Schedule name'),h('input',{value:name,disabled:locked,maxLength:120,required:true,'data-fleet-schedule-name':'',onChange:e=>setName(e.target.value)})),
      h(TimingFields,{L,state:timing,onChange:setTiming,disabled:locked}),
      summary,
      (localError||error)&&h('p',{className:'fl-notice',role:'alert','data-fleet-schedule-error':''},localError||error),
      h('div',{className:'fl-dialog-actions'},
        onCancel&&button(L('取消','Cancel'),onCancel,{className:'fl-btn fl-btn-ghost',disabled:submitting}),
        button(submitting?L('正在启用…','Enabling…'):(submitLabel||L('启用计划','Enable schedule')),undefined,{type:'submit',className:'fl-btn fl-btn-primary',disabled:locked,'data-fleet-schedule-submit':''}))));
  }
  // 模板补齐表单：goal/inputs/deliverables/criteria/requirements＋逐节点 Agent 分配；预约模式附带时间规则。
  function TemplateTicketForm({L,flow,catalog,mode='instantiate',busy=false,error=null,unavailable=null,onSubmit,onCancel}) {
    const nodes=list(flow?.definition?.nodes),agents=list(catalog?.agents);
    // P-72: template defaults only prefill this form; they stay editable and never enter the plan implicitly.
    const defaults=flow?.definition?.defaults??{};
    const hasDefaults=Object.keys(defaults).length>0;
    const defaultDeliverablesText=items=>!Array.isArray(items)?'':items.every(item=>typeof item==='string')?items.join('\n'):JSON.stringify(items,null,2);
    const [goal,setGoal]=React.useState(typeof defaults.goal==='string'?defaults.goal:'');
    const [inputsText,setInputsText]=React.useState(()=>defaults.inputs&&typeof defaults.inputs==='object'&&Object.keys(defaults.inputs).length?JSON.stringify(defaults.inputs,null,2):'');
    const [deliverablesText,setDeliverablesText]=React.useState(()=>defaultDeliverablesText(defaults.deliverables));
    const [criteriaText,setCriteriaText]=React.useState(()=>list(defaults.criteria).join('\n'));
    const [requirements,setRequirements]=React.useState(typeof defaults.requirements==='string'?defaults.requirements:'');
    const [assignments,setAssignments]=React.useState(()=>Object.fromEntries(nodes.map(node=>[node.id,agents.some(a=>a.id===node.agentId)?node.agentId:''])));
    const [name,setName]=React.useState(`${flow?.name||flow?.id||''}`);
    const [timing,setTiming]=React.useState(()=>initialTimingState());
    const [localError,setLocalError]=React.useState(null);
    const [missing,setMissing]=React.useState([]);
    const [submitting,setSubmitting]=React.useState(false);
    const [done,setDone]=React.useState(null);
    const locked=busy||submitting||!!unavailable;
    const lines=value=>String(value||'').split('\n').map(x=>x.trim()).filter(Boolean);
    async function submit(event){
      event.preventDefault();
      if(locked)return;
      if(!goal.trim()){setLocalError(L('请填写任务目标。','Please enter a goal.'));return;}
      let deliverables;
      const trimmedDeliverables=deliverablesText.trim();
      if(trimmedDeliverables.startsWith('[')){
        try{deliverables=JSON.parse(trimmedDeliverables);}catch{setLocalError(L('交付物 JSON 格式有误。','Deliverables JSON is invalid.'));return;}
        if(!Array.isArray(deliverables)){setLocalError(L('交付物须为 JSON 数组或每行一项。','Deliverables must be a JSON array or one item per line.'));return;}
      }else deliverables=lines(deliverablesText);
      if(mode==='schedule'&&!deliverables.length){setLocalError(L('请至少填写一项交付物（每行一项）。','Add at least one deliverable (one per line).'));return;}
      let inputs={};
      if(inputsText.trim()){try{inputs=JSON.parse(inputsText);}catch{setLocalError(L('输入 JSON 格式有误。','Inputs JSON is invalid.'));return;}
        if(!inputs||typeof inputs!=='object'||Array.isArray(inputs)){setLocalError(L('输入须为 JSON 对象。','Inputs must be a JSON object.'));return;}}
      const unassigned=nodes.filter(node=>!assignments[node.id]).map(node=>node.id);
      setMissing(unassigned);
      if(unassigned.length){setLocalError(L('以下节点缺少 Agent 分配：','These nodes have no Agent assignment: ')+unassigned.join(', '));return;}
      const args={templateId:flow.id,templateRevision:flow.revision,overrides:{goal:goal.trim(),inputs,deliverables,criteria:lines(criteriaText),...(requirements.trim()?{requirements:requirements.trim()}:{})},assignments:{...assignments}};
      if(mode==='schedule'){
        const trimmed=name.trim();
        if(!trimmed||trimmed.length>120){setLocalError(L('名称需为 1–120 个字符。','Name must be 1–120 characters.'));return;}
        const built=buildTiming(timing,L);
        if(built.error){setLocalError(built.error);return;}
        args.name=trimmed;args.timing=built.timing;
      }
      setLocalError(null);setSubmitting(true);
      try{const result=await onSubmit(args);if(result&&mode==='schedule')setDone(result);}
      finally{setSubmitting(false);}
    }
    if(done)return h('div',{className:'fl-stack','data-fleet-schedule-created':''},
      h('p',{className:'fl-notice',role:'status'},L('计划已启用，到点将按冻结配置自动建票。','Schedule enabled; Tickets will be created from the frozen configuration.')),
      kv(L('下次执行','Next run'),zoneTimestamp(nextSeriesTime(done) ?? seriesScheduledAt({host:done}),timing.zone,L)),
      h('div',{className:'fl-dialog-actions'},button(L('完成','Done'),onCancel,{className:'fl-btn fl-btn-primary','data-fleet-schedule-done':''})));
    return h('form',{onSubmit:submit,'data-fleet-instantiate-form':flow?.id||''},h('div',{className:'fl-stack'},
      unavailable&&h('p',{className:'fl-notice',role:'alert','data-fleet-schedule-unavailable':''},unavailable),
      h('p',{className:'fl-help'},L('模板含节点、关卡与可选默认值；默认值只预填本表单，可修改。补齐后按值复制为普通草稿（保留来源版本）。','The template holds nodes, gates and optional defaults. Defaults only prefill this form and stay editable; the result is a normal draft copied by value with source revisions retained.')),
      hasDefaults&&h('p',{className:'fl-notice',role:'status','data-fleet-instantiate-defaults':''},L('已按模板默认值预填，可修改。','Prefilled from the template defaults; edit as needed.')),
      mode==='schedule'&&h('label',{className:'fl-field'},L('计划名称','Schedule name'),h('input',{value:name,disabled:locked,maxLength:120,required:true,'data-fleet-schedule-name':'',onChange:e=>setName(e.target.value)})),
      h('label',{className:'fl-field'},L('任务目标','Goal'),h('textarea',{value:goal,disabled:locked,rows:3,required:true,'data-fleet-instantiate-goal':'',onChange:e=>setGoal(e.target.value)})),
      h('label',{className:'fl-field'},L('输入（JSON 对象，可空）','Inputs (JSON object, optional)'),h('textarea',{value:inputsText,disabled:locked,rows:3,'data-fleet-instantiate-inputs':'',onChange:e=>setInputsText(e.target.value)})),
      h('label',{className:'fl-field'},L('交付物（每行一项，或 JSON 数组）','Deliverables (one per line, or a JSON array)'),h('textarea',{value:deliverablesText,disabled:locked,rows:3,required:mode==='schedule','data-fleet-instantiate-deliverables':'',onChange:e=>setDeliverablesText(e.target.value)})),
      h('label',{className:'fl-field'},L('整单验收标准（每行一条，可空）','Ticket-wide criteria (one per line, optional)'),h('textarea',{value:criteriaText,disabled:locked,rows:2,'data-fleet-instantiate-criteria':'',onChange:e=>setCriteriaText(e.target.value)})),
      h('label',{className:'fl-field'},L('补充要求（可空）','Requirements (optional)'),h('textarea',{value:requirements,disabled:locked,rows:2,'data-fleet-instantiate-requirements':'',onChange:e=>setRequirements(e.target.value)})),
      h('div',{className:'fl-field'},h('span',null,L('节点 Agent 分配','Node Agent assignments')),
        nodes.length?h('div',{className:'fl-stack'},...nodes.map(node=>h('label',{className:'fl-field',key:node.id,'data-fleet-instantiate-node':node.id},
          `${node.id}${node.role?` · ${node.role}`:''}${node.agentId?L(`（模板预填：${node.agentId}）`,` (template preset: ${node.agentId})`):''}`,
          h('select',{value:assignments[node.id]||'',disabled:locked,'data-fleet-instantiate-agent':node.id,onChange:e=>setAssignments({...assignments,[node.id]:e.target.value})},
            h('option',{value:''},L('请选择 Root Agent','Choose a Root Agent')),
            ...agents.map(agent=>h('option',{key:agent.id,value:agent.id},`${agent.name||agent.id} · v${agent.revision}`))))))
          :h('p',{className:'fl-help'},L('此模板没有节点。','This template has no nodes.')),
        missing.length>0&&h('p',{className:'fl-notice',role:'alert','data-fleet-instantiate-missing':''},L('缺分配的节点：','Nodes missing assignments: ')+missing.join(', '))),
      mode==='schedule'&&h(TimingFields,{L,state:timing,onChange:setTiming,disabled:locked}),
      mode==='schedule'&&h('div',{className:'fl-notice fl-spaced','data-fleet-schedule-summary':''},
        h('p',{className:'fl-small fl-muted'},L('启用时把模板版本与补齐后的完整配置一起冻结；模板后续改版不影响本系列。','Enabling freezes the template revision together with the completed configuration; later template edits do not affect this series.')),
        kv(L('模板版本','Template revision'),`${flow.id} · v${flow.revision}`),kv(L('目标','Goal'),goal),kv(L('输入','Inputs'),inputsText||'—'),kv(L('交付物','Deliverables'),deliverablesText||'—'),kv(L('整单标准','Criteria'),criteriaText||'—'),kv(L('补充要求','Requirements'),requirements||'—'),...nodes.map(node=>kv(node.id,assignments[node.id]||L('未分配','Unassigned'))),details(L('节点与关卡','Nodes and gates'),flow.definition)),
      (localError||error)&&h('p',{className:'fl-notice',role:'alert','data-fleet-instantiate-error':''},localError||error),
      h('div',{className:'fl-dialog-actions'},
        onCancel&&button(L('取消','Cancel'),onCancel,{className:'fl-btn fl-btn-ghost',disabled:submitting}),
        button(submitting?L('正在提交…','Submitting…'):(mode==='schedule'?L('启用计划','Enable schedule'):L('创建草稿','Create draft')),undefined,{type:'submit',className:'fl-btn fl-btn-primary',disabled:locked,'data-fleet-instantiate-submit':''}))));
  }
  // P-72／P-73 provenance display: a copied Template revision, or the source Ticket (and node) revision.
  const templateSourceText=(source,L)=>!source?'—'
    :source.templateId?`${source.templateId} · ${source.templateRevision==null?L('版本未知','revision unknown'):`v${source.templateRevision}`}`
    :`${L('来源 Ticket','Source Ticket')} ${source.ticketId} · v${source.ticketRevision}${source.nodeId?` · ${L('节点','node')} ${source.nodeId}`:''}`;
  // P-73: copy a Ticket's saved plan into a reusable orchestration template. Each local Agent is
  // linked to an existing Root template, saved as a new one, or left unassigned; concrete Ticket/series
  // dependencies are stripped. The preview uses the same value-copy rules as the Core write.
  function SaveOrchestrationForm({L,ticket,catalog,busy=false,error=null,onSubmit,onCancel}) {
    const plan=ticket.plan??{};
    const localAgents=Object.entries(plan.agents??{});
    const agentTemplates=list(catalog?.agents),orchestrations=list(catalog?.orchestrations);
    const takenIds=new Set([...agentTemplates,...orchestrations].map(t=>t.id));
    const agentSourceRefs={};
    for(const a of list(ticket.activity))if(a.type==='template-applied'&&a.detail?.kind==='agent'&&a.detail.localId)agentSourceRefs[a.detail.localId]=a.detail;
    const suggestId=()=>{const base=(ticketTitle(ticket)||ticket.id||'flow').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40)||'flow';let id=base,n=2;while(takenIds.has(id))id=`${base}-${n++}`;return id;};
    const [mode,setMode]=React.useState('new');
    const [newId,setNewId]=React.useState(suggestId);
    const [updateId,setUpdateId]=React.useState(orchestrations[0]?.id??'');
    const [name,setName]=React.useState(ticketTitle(ticket));
    const [mapping,setMapping]=React.useState(()=>Object.fromEntries(localAgents.map(([localId,agent])=>{
      const ref=agentSourceRefs[localId];
      if(ref&&agentTemplates.some(t=>t.id===ref.templateId))return [localId,{mode:'link',templateId:ref.templateId}];
      return [localId,{mode:'save',id:takenIds.has(localId)?`${localId}-agent`:localId,name:agent.name||localId}];
    })));
    const [localError,setLocalError]=React.useState(null);
    const [submitting,setSubmitting]=React.useState(false);
    const locked=busy||submitting;
    const setMap=(localId,patch)=>setMapping(m=>({...m,[localId]:{...m[localId],...patch}}));
    const sharedNodes=localId=>list(plan.nodes).filter(n=>n.agentId===localId).map(n=>n.id);
    const strippedNodes=list(plan.nodes).filter(n=>list(n.ticketDependencies).length||list(n.ticketDependencySeries).length).map(n=>n.id);
    const ticketLevelDeps=list(plan.ticketDependencies).length>0||list(plan.ticketDependencySeries).length>0;
    const previewContent=orchestrationContentFromPlan(plan,mapping);
    async function submit(event){
      event.preventDefault();
      if(locked)return;
      const templateId=(mode==='new'?newId:updateId).trim();
      if(!templateId){setLocalError(L('请填写模板 ID。','Please enter a template ID.'));return;}
      const agentMapping={};
      for(const [localId,entry] of Object.entries(mapping)){
        if(entry.mode==='link'){
          if(!entry.templateId){setLocalError(L(`请为 ${localId} 选择要关联的 Agent 模板。`,`Choose an Agent template to link for ${localId}.`));return;}
          agentMapping[localId]={mode:'link',templateId:entry.templateId};
        }else if(entry.mode==='save'){
          const id=(entry.id||'').trim();
          if(!id){setLocalError(L(`请为 ${localId} 填写新 Agent 模板 ID。`,`Enter a new Agent template ID for ${localId}.`));return;}
          const nm=(entry.name||'').trim();
          agentMapping[localId]={mode:'save',id,...(nm?{name:nm}:{})};
        }else agentMapping[localId]={mode:'leave'};
      }
      const nm=name.trim();
      setLocalError(null);setSubmitting(true);
      try{await onSubmit({ticketId:ticket.id,id:templateId,...(nm?{name:nm}:{}),agentMapping,source:{ticketId:ticket.id,ticketRevision:ticket.revision,workspaceId:ticket.workspaceId},update:mode==='update'});}
      finally{setSubmitting(false);}
    }
    return h('form',{onSubmit:submit,'data-fleet-save-orchestration-form':ticket.id},h('div',{className:'fl-stack'},
      h('p',{className:'fl-help'},L('把此 Ticket 的当前已保存计划按值保存为 Root 编排模板；不改动 Ticket 本身，只追加一条活动记录。','Save this Ticket’s current saved plan by value as a Root orchestration template. The Ticket itself is unchanged; only one activity record is appended.')),
      h('div',{className:'fl-row'},
        button(L('保存为新模板','Save as new template'),()=>setMode('new'),{'aria-pressed':mode==='new','data-fleet-template-mode-new':'',disabled:locked}),
        button(L('更新已有模板','Update existing template'),()=>setMode('update'),{'aria-pressed':mode==='update','data-fleet-template-mode-update':'',disabled:locked})),
      mode==='new'
        ?h('label',{className:'fl-field'},L('模板 ID','Template ID'),h('input',{value:newId,disabled:locked,required:true,'data-fleet-template-new-id':'',onChange:e=>setNewId(e.target.value)}))
        :h('label',{className:'fl-field'},L('选择要更新的模板','Template to update'),h('select',{value:updateId,disabled:locked,'data-fleet-template-update-id':'',onChange:e=>setUpdateId(e.target.value)},...orchestrations.map(t=>h('option',{key:t.id,value:t.id},`${t.name||t.id} · v${t.revision}`)))),
      h('label',{className:'fl-field'},L('名称（可选）','Name (optional)'),h('input',{value:name,disabled:locked,'data-fleet-template-name':'',onChange:e=>setName(e.target.value)})),
      (strippedNodes.length>0||ticketLevelDeps)&&h('p',{className:'fl-notice','data-fleet-template-stripped':''},L('具体 Ticket／系列依赖不会进入模板（模板可复用，不绑定具体任务）。','Concrete Ticket/series dependencies are stripped from the template (templates are reusable and not bound to specific Tickets).')+(strippedNodes.length?L(` 涉及节点：${strippedNodes.join(' · ')}。`,` Affected nodes: ${strippedNodes.join(' · ')}.`):'')),
      localAgents.length>0&&h('div',{className:'fl-field'},h('span',null,L('本地 Agent 处理','Local Agent handling')),
        h('div',{className:'fl-stack'},...localAgents.map(([localId,agent])=>{
          const entry=mapping[localId]||{mode:'leave'};
          const shared=sharedNodes(localId);
          return h('div',{className:'fl-card fl-card-pad',key:localId,'data-fleet-agent-map':localId},
            h('div',{className:'fl-row fl-between'},h('strong',null,agent.name||localId),h('span',{className:'fl-mono fl-small fl-muted'},localId)),
            shared.length>1&&h('p',{className:'fl-small fl-muted'},L(`共用节点：${shared.join(' · ')}`,`Shared nodes: ${shared.join(' · ')}`)),
            h('select',{value:entry.mode,disabled:locked,'data-fleet-agent-map-mode':localId,onChange:e=>setMap(localId,{mode:e.target.value})},
              h('option',{value:'link'},L('关联已有 Agent 模板','Link an existing Agent template')),
              h('option',{value:'save'},L('保存为新 Agent 模板','Save as a new Agent template')),
              h('option',{value:'leave'},L('留空（实例化时分配）','Leave unassigned (assign at instantiation)'))),
            entry.mode==='link'&&h('select',{value:entry.templateId||'',disabled:locked,'data-fleet-agent-map-link':localId,onChange:e=>setMap(localId,{templateId:e.target.value})},
              h('option',{value:''},L('请选择 Agent 模板','Choose an Agent template')),
              ...agentTemplates.map(t=>h('option',{key:t.id,value:t.id},`${t.name||t.id} · v${t.revision}`))),
            entry.mode==='save'&&h('div',{className:'fl-row'},
              h('input',{value:entry.id||'',disabled:locked,placeholder:L('新模板 ID','New template ID'),'data-fleet-agent-map-save-id':localId,onChange:e=>setMap(localId,{id:e.target.value})}),
              h('input',{value:entry.name||'',disabled:locked,placeholder:L('名称（可选）','Name (optional)'),'data-fleet-agent-map-save-name':localId,onChange:e=>setMap(localId,{name:e.target.value})})));
        }))),
      h('details',{className:'fl-spaced','data-fleet-template-preview':''},h('summary',null,L('预览将写入的模板内容','Preview the template content')),h('pre',null,json(previewContent))),
      (localError||error)&&h('p',{className:'fl-notice',role:'alert','data-fleet-save-orchestration-error':''},localError||error),
      h('div',{className:'fl-dialog-actions'},
        onCancel&&button(L('取消','Cancel'),onCancel,{className:'fl-btn fl-btn-ghost',disabled:submitting}),
        button(submitting?L('正在保存…','Saving…'):L('保存编排模板','Save orchestration template'),undefined,{type:'submit',className:'fl-btn fl-btn-primary',disabled:locked,'data-fleet-save-orchestration-submit':''}))));
  }
  // P-73／decision F: save one node's local Agent as a Root Agent template. The profile is copied
  // as-is; the node's modelSelection becomes the Agent default only via the explicit checkbox.
  function SaveAgentForm({L,ticket,nodeId,catalog,busy=false,error=null,onSubmit,onCancel}) {
    const plan=ticket.plan??{};
    const node=list(plan.nodes).find(n=>n.id===nodeId);
    const agent=node?.agentId!=null?plan.agents?.[node.agentId]:null;
    const agentTemplates=list(catalog?.agents);
    const takenIds=new Set([...agentTemplates,...list(catalog?.orchestrations)].map(t=>t.id));
    const baseId=node?.agentId||nodeId||'agent';
    const suggestId=()=>{let id=takenIds.has(baseId)?`${baseId}-agent`:baseId,n=2;while(takenIds.has(id))id=`${baseId}-${n++}`;return id;};
    const [mode,setMode]=React.useState('new');
    const [newId,setNewId]=React.useState(suggestId);
    const [updateId,setUpdateId]=React.useState(agentTemplates[0]?.id??'');
    const [name,setName]=React.useState(agent?.name||node?.agentId||nodeId||'');
    const [includeModel,setIncludeModel]=React.useState(false);
    const [localError,setLocalError]=React.useState(null);
    const [submitting,setSubmitting]=React.useState(false);
    const locked=busy||submitting||!agent;
    const sharedNodes=list(plan.nodes).filter(n=>n.agentId===node?.agentId).map(n=>n.id);
    const nodeModel=node?.modelSelection;
    const profile=agent?{...agent.profile,...(includeModel&&nodeModel?{modelSelection:nodeModel}:{})}:{};
    const content={...(agent?.name!==undefined?{name:agent.name}:{}),profile};
    async function submit(event){
      event.preventDefault();
      if(locked)return;
      const templateId=(mode==='new'?newId:updateId).trim();
      if(!templateId){setLocalError(L('请填写模板 ID。','Please enter a template ID.'));return;}
      const nm=name.trim();
      setLocalError(null);setSubmitting(true);
      try{await onSubmit({kind:'agent',id:templateId,...(nm?{name:nm}:{}),content,source:{ticketId:ticket.id,ticketRevision:ticket.revision,workspaceId:ticket.workspaceId,nodeId},update:mode==='update'});}
      finally{setSubmitting(false);}
    }
    if(!agent)return h('div',{className:'fl-stack'},h('p',{className:'fl-notice',role:'alert'},L('此节点没有可保存的本地 Agent。','This node has no local Agent to save.')),h('div',{className:'fl-dialog-actions'},button(L('关闭','Close'),onCancel,{className:'fl-btn fl-btn-ghost'})));
    return h('form',{onSubmit:submit,'data-fleet-save-agent-form':nodeId},h('div',{className:'fl-stack'},
      h('p',{className:'fl-help'},L('把此节点的本地 Agent 按值保存为 Root Agent 模板；Profile 原样复制，不改动 Ticket。','Save this node’s local Agent by value as a Root Agent template; the profile is copied as-is and the Ticket is unchanged.')),
      kv(L('来源节点','Source node'),`${nodeId} · ${node.agentId}`),
      sharedNodes.length>1&&h('p',{className:'fl-help','data-fleet-save-agent-shared':''},L(`同一 Agent 还被这些节点使用：${sharedNodes.join(' · ')}。模板只保存 Agent 定义。`,`The same Agent is also used by: ${sharedNodes.join(' · ')}. The template saves the Agent definition only.`)),
      h('div',{className:'fl-row'},
        button(L('保存为新模板','Save as new template'),()=>setMode('new'),{'aria-pressed':mode==='new','data-fleet-save-agent-mode-new':'',disabled:locked}),
        button(L('更新已有模板','Update existing template'),()=>setMode('update'),{'aria-pressed':mode==='update','data-fleet-save-agent-mode-update':'',disabled:locked})),
      mode==='new'
        ?h('label',{className:'fl-field'},L('模板 ID','Template ID'),h('input',{value:newId,disabled:locked,required:true,'data-fleet-save-agent-id':'',onChange:e=>setNewId(e.target.value)}))
        :h('label',{className:'fl-field'},L('选择要更新的模板','Template to update'),h('select',{value:updateId,disabled:locked,'data-fleet-save-agent-update':'',onChange:e=>setUpdateId(e.target.value)},...agentTemplates.map(t=>h('option',{key:t.id,value:t.id},`${t.name||t.id} · v${t.revision}`)))),
      h('label',{className:'fl-field'},L('名称（可选）','Name (optional)'),h('input',{value:name,disabled:locked,'data-fleet-save-agent-name':'',onChange:e=>setName(e.target.value)})),
      nodeModel&&h('label',{className:'fl-row fl-small'},h('input',{type:'checkbox',checked:includeModel,disabled:locked,'data-fleet-save-agent-model':'',onChange:e=>setIncludeModel(e.target.checked)}),L(`把本节点模型设为该 Agent 默认（${nodeModel.provider}/${nodeModel.model}${nodeModel.reasoningEffort?` · ${nodeModel.reasoningEffort}`:''}）`,`Set this node’s model as the Agent default (${nodeModel.provider}/${nodeModel.model}${nodeModel.reasoningEffort?` · ${nodeModel.reasoningEffort}`:''})`)),
      h('div',{className:'fl-field'},h('span',null,L('将写入的内容','Content to be written')),readValue(content)),
      (localError||error)&&h('p',{className:'fl-notice',role:'alert','data-fleet-save-agent-error':''},localError||error),
      h('div',{className:'fl-dialog-actions'},
        onCancel&&button(L('取消','Cancel'),onCancel,{className:'fl-btn fl-btn-ghost',disabled:submitting}),
        button(submitting?L('正在保存…','Saving…'):L('保存 Agent 模板','Save Agent template'),undefined,{type:'submit',className:'fl-btn fl-btn-primary',disabled:locked,'data-fleet-save-agent-submit':''}))));
  }
  // P-68 calendar projection: past occurrences are facts; future slots are projected
  // client-side only for at/daily/weekly in the series timezone. every/cron/rrule show
  // just the host's next scheduledAt. The host remains the authority for actual delivery.
  const zonedParts=(date,tz)=>{const f=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});const p=Object.fromEntries(f.formatToParts(date).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));return {y:+p.year,m:+p.month,d:+p.day,h:+p.hour%24,min:+p.minute};};
  const zonedTimeToUtc=(y,m,d,hh,mm,tz)=>{let t=Date.UTC(y,m-1,d,hh,mm);for(let i=0;i<2;i++){const q=zonedParts(new Date(t),tz);t+=Date.UTC(y,m-1,d,hh,mm)-Date.UTC(q.y,q.m-1,q.d,q.h,q.min);}return new Date(t);};
  function nextSeriesTime(series) {
    const scheduledAt = seriesScheduledAt(series);
    if (scheduledAt) return scheduledAt;
    const at = effectiveSeriesTiming(series)?.at;
    if (typeof at === 'string') {
      const wallTimeAsUtc = at.replace(/(?:Z|[+-]\d\d:\d\d)$/, 'Z');
      const epoch = Date.parse(at);
      return isUtcInstant(wallTimeAsUtc) && Number.isFinite(epoch) ? new Date(epoch) : null;
    }
    if (!at?.time_zone || !/^\d{4}-\d\d-\d\d$/.test(at.date) || !/^\d\d:\d\d(?::[0-5]\d(?:\.\d{1,3})?)?$/.test(at.time)) return null;
    const [y,m,d] = at.date.split('-').map(Number);
    const [hh,mm,ss=0] = at.time.split(':').map(Number);
    try {
      const instant = zonedTimeToUtc(y,m,d,hh,mm,at.time_zone);
      const parts = zonedParts(instant,at.time_zone);
      if (parts.y!==y || parts.m!==m || parts.d!==d || parts.h!==hh || parts.min!==mm) return null;
      return new Date(instant.getTime()+Math.round(ss*1000));
    } catch { return null; }
  }
  const localDayKey=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const clockText=d=>`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  function projectSeries(series,from,to){
    const out=[],zone=seriesZone(series),occ=list(series.occurrences),seen=new Set();
    for(const oc of occ){const t=Date.parse(oc.occurrenceAt);if(!Number.isFinite(t))continue;seen.add(t);
      const startedAt=oc.status==='started'&&oc.createdAt?new Date(oc.createdAt):null;
      const displayAt=startedAt?.getTime()??t;
      if(displayAt>=from&&displayAt<to)out.push({series,at:new Date(t),startedAt,state:oc.status==='failed'?'failed':oc.status==='waiting'?'waiting':'done',ticketId:oc.ticketId||null,error:oc.error||null});}
    if(series.triggerSeriesId||['ended','orphaned'].includes(series.status))return out;
    const timing=effectiveSeriesTiming(series),kind=timing?.kind,paused=series.status==='paused';
    const push=at=>{const t=at.getTime();if(!Number.isFinite(t)||t<from||t>=to||t<Date.now()-60000)return;
      // A receipt may differ from the projected instant by sub-second precision.
      for(const s of seen)if(Math.abs(s-t)<1000)return;seen.add(t);
      out.push({series,at,startedAt:null,state:paused?'paused':'upcoming',ticketId:null,error:null});};
    if(kind==='daily'||kind==='weekly'){
      const time=String(timing[kind].time||'');const [hh,mm]=time.split(':').map(Number);
      if(!Number.isFinite(hh)||!Number.isFinite(mm))return out;
      const days=kind==='weekly'?list(timing.weekly.weekdays):[1,2,3,4,5,6,7];
      const sp=zonedParts(new Date(from-86400000),zone),ep=zonedParts(new Date(to+86400000),zone);
      const end=Date.UTC(ep.y,ep.m-1,ep.d);
      for(let cur=Date.UTC(sp.y,sp.m-1,sp.d);cur<=end;cur+=86400000){
        const d=new Date(cur),wd=d.getUTCDay()===0?7:d.getUTCDay();
        if(days.includes(wd))push(zonedTimeToUtc(d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate(),hh,mm,zone));}
    }else{
      const next=nextSeriesTime(series);
      if(next)push(new Date(next));
    }
    return out;
  }
  const calEventTone={waiting:'waiting',upcoming:null,done:'success',failed:'danger',paused:'waiting',ended:null};
  const calEventName=(state,L)=>({waiting:L('等待上游','Waiting for upstream'),upcoming:L('待执行','Upcoming'),done:L('已建票','Started'),failed:L('失败','Failed'),paused:L('已暂停','Paused'),ended:L('已结束','Ended')})[state]||state;
  function ScheduleCalendar({L,items,act,busy,navigate,openDialog,unavailable,workspaceBlocked}){
    const [view,setView]=React.useState('week');
    const [anchor,setAnchor]=React.useState(()=>new Date());
    const [pop,setPop]=React.useState(null);
    const popRef=React.useRef(null);
    React.useEffect(()=>{
      if(!pop)return;
      const key=e=>{if(e.key==='Escape')setPop(null);};
      const down=e=>{if(popRef.current&&!popRef.current.contains(e.target)&&!e.target.closest?.('[data-fleet-cal-event]'))setPop(null);};
      document.addEventListener('keydown',key);document.addEventListener('mousedown',down);
      return()=>{document.removeEventListener('keydown',key);document.removeEventListener('mousedown',down);};
    },[pop]);
    const startOfDay=d=>new Date(d.getFullYear(),d.getMonth(),d.getDate());
    const startOfWeek=d=>{const x=startOfDay(d);const w=x.getDay()===0?7:x.getDay();x.setDate(x.getDate()-(w-1));return x;};
    const addDays=(d,n)=>{const x=new Date(d);x.setDate(x.getDate()+n);return x;};
    const today=new Date(),todayKey=localDayKey(today);
    const gridStart=view==='month'?startOfWeek(new Date(anchor.getFullYear(),anchor.getMonth(),1)):view==='week'?startOfWeek(anchor):startOfDay(anchor);
    const dayCount=view==='month'?42:view==='week'?7:1;
    const days=[...Array(dayCount)].map((_,i)=>addDays(gridStart,i));
    const from=gridStart.getTime(),to=addDays(gridStart,dayCount).getTime();
    const events=items.flatMap(s=>projectSeries(s,from,to));
    const byDay=new Map();
    for(const e of events){const k=localDayKey(e.startedAt||e.at);if(!byDay.has(k))byDay.set(k,[]);byDay.get(k).push(e);}
    for(const arr of byDay.values())arr.sort((a,b)=>(a.startedAt||a.at)-(b.startedAt||b.at));
    const openPop=(e,el)=>{const r=el.getBoundingClientRect();setPop({e,rect:{left:r.left,right:r.right,top:r.top,width:r.width}});};
    const shift=n=>{setPop(null);setAnchor(a=>{if(view==='month'){const x=new Date(a.getFullYear(),a.getMonth(),1);x.setMonth(x.getMonth()+n);return x;}return addDays(a,n*(view==='week'?7:1));});};
    const goDay=d=>{setPop(null);setAnchor(startOfDay(d));setView('day');};
    const rangeText=view==='month'?anchor.toLocaleDateString(L('zh-CN','en'),{year:'numeric',month:'long'})
      :view==='week'?(()=>{const b=addDays(gridStart,6);const f=o=>gridStart.toLocaleDateString(L('zh-CN','en'),o);return `${f({month:'numeric',day:'numeric'})} – ${b.toLocaleDateString(L('zh-CN','en'),{month:'numeric',day:'numeric'})}`;})()
      :anchor.toLocaleDateString(L('zh-CN','en'),{year:'numeric',month:'long',day:'numeric'});
    const card=(e,wide)=>h('button',{type:'button',className:'fl-cal-ev',key:JSON.stringify([e.series.workspaceId,e.series.id,e.at.toISOString()]),'data-fleet-cal-event':e.series.id,onClick:ev=>{ev.stopPropagation();openPop(e,ev.currentTarget);}},
      h('strong',{className:'fl-cal-name'},e.series.name||e.series.id),
      h('span',{className:'fl-cal-foot'},
        h('span',{className:'fl-cal-time'},h('small',null,e.startedAt?L('实际开始','Started'):L('计划开始','Planned')),clockText(e.startedAt||e.at)),
        badge(calEventName(e.state,L),calEventTone[e.state]||'neutral')),
      e.series.projectTitle&&h('span',{className:'fl-cal-src'},e.series.projectTitle),
      wide&&h('span',{className:'fl-cal-src'},`${timingSummary(e.series,L)} · ${e.series.sourceTicketId||e.series.sourceTemplateId||''}`));
    const stack=(d,wide)=>{const arr=byDay.get(localDayKey(d))||[];return h('div',{className:'fl-cal-stack'},arr.length?arr.map(e=>card(e,wide)):h('p',{className:'fl-cal-empty'},L('无计划','Nothing scheduled')));};
    let body;
    if(view==='week'){
      body=h('div',{className:'fl-cal-week'},...days.map((d,i)=>{const isToday=localDayKey(d)===todayKey;
        return h('section',{className:'fl-cal-col',key:localDayKey(d),'data-today':isToday,'data-fleet-cal-col':localDayKey(d)},
          h('button',{type:'button',className:'fl-cal-day','aria-current':isToday?'date':undefined,onClick:()=>goDay(d)},
            h('span',null,weekdayNames(L)[i]),h('strong',null,`${d.getMonth()+1}/${d.getDate()}`)),
          stack(d));}));
    }else if(view==='month'){
      body=h('div',{className:'fl-cal-mwrap'},
        h('div',{style:{display:'grid',gridTemplateColumns:'repeat(7,minmax(0,1fr))'}},...weekdayNames(L).map(w=>h('div',{className:'fl-cal-mhead',key:w},w))),
        h('div',{className:'fl-cal-month'},...days.map(d=>{const k=localDayKey(d),arr=byDay.get(k)||[],out=d.getMonth()!==anchor.getMonth(),isToday=k===todayKey;
          return h('div',{className:'fl-cal-mcell',key:k,'data-day':k,'data-out':out,'data-today':isToday,'data-fleet-cal-cell':k,onClick:()=>goDay(d)},
            h('span',{className:'fl-cal-mdn'},String(d.getDate())),
            ...arr.slice(0,3).map(e=>h('span',{className:'fl-cal-mitem',key:JSON.stringify([e.series.workspaceId,e.series.id,e.at.toISOString()]),title:e.series.projectTitle,'data-tone':e.state},
              h('i',{className:'fl-dot'}),h('span',{className:'fl-cal-mtime'},clockText(e.startedAt||e.at)),h('span',{className:'fl-cal-mname'},e.series.name||e.series.id))),
            arr.length>3&&h('button',{type:'button',className:'fl-cal-more','data-fleet-cal-more':k,onClick:ev=>{ev.stopPropagation();goDay(d);}},L(`还有 ${arr.length-3} 项`,`${arr.length-3} more`)));})));
    }else{
      body=h('section',{className:'fl-cal-dayview'},
        h('h2',null,anchor.toLocaleDateString(L('zh-CN','en'),{weekday:'long',month:'long',day:'numeric'})),
        stack(anchor,true));
    }
    let popNode=null;
    if(pop){
      const {e,rect}=pop,w=340,g=12,vw=window.innerWidth,vh=window.innerHeight;
      let left=rect.right+g;if(left+w>vw-12)left=Math.max(12,rect.left-w-g);
      const s=e.series,zone=seriesZone(s),blocked=workspaceBlocked?.(s.workspaceId);
      popNode=h('div',{className:'fl-cal-pop',ref:popRef,role:'dialog','aria-label':s.name||s.id,'data-fleet-cal-pop':s.id,style:{left:left+'px',top:'132px'}},
        h('div',{className:'fl-cal-pophead'},h('strong',null,s.name||s.id),button(L('关闭','Close'),()=>setPop(null),{className:'fl-btn fl-btn-ghost fl-btn-sm','data-fleet-cal-pop-close':''})),
        h('div',{className:'fl-cal-popbody'},
          h('div',{className:'fl-cal-kv'},h('span',null,L('时间','Time')),h('span',null,zoneTimestamp((e.startedAt||e.at).toISOString(),zone,L))),
          h('div',{className:'fl-cal-kv'},h('span',null,L('状态','Status')),h('span',null,badge(calEventName(e.state,L),calEventTone[e.state]||'neutral'))),
          h('div',{className:'fl-cal-kv'},h('span',null,L('起点','Basis')),h('span',{className:'fl-muted'},e.startedAt?`${L('实际开始','Started')} ${clockText(e.startedAt)}`:`${L('计划开始','Planned')} ${clockText(e.at)}`)),
          h('div',{className:'fl-cal-kv'},h('span',null,L('规则','Rule')),h('span',{className:'fl-muted'},timingSummary(s,L))),
          h('div',{className:'fl-cal-kv'},h('span',null,L('来源','Source')),h('span',{className:'fl-mono'},s.sourceTemplateId?`${L('模板','Template')} · ${s.sourceTemplateId}`:s.sourceTicketId?`Ticket · ${s.sourceTicketId}`:L('来源未知','Unknown source'))),
          s.projectTitle&&h('p',{className:'fl-cal-src'},s.projectTitle),
           blocked&&h('p',{className:'fl-help'},L('请先开启该工作区的 Fleet 模式。','Enable Fleet for this workspace first.')),
           e.error&&h('p',{className:'fl-small',role:'status','data-fleet-cal-pop-error':''},e.error),
          h('div',{className:'fl-cal-actions'},
            e.ticketId&&button(L('打开本期 Ticket','Open this occurrence'),()=>{setPop(null);navigate('ticket',{ticketId:e.ticketId,nodeId:null},s);},{disabled:blocked,'data-fleet-cal-pop-ticket':e.ticketId}),
            s.status==='active'&&button(L('暂停计划','Pause schedule'),()=>{setPop(null);act('series-pause',{seriesId:s.id},s);},{disabled:busy||blocked||!!unavailable,'data-fleet-cal-pop-pause':s.id}),
            s.status==='paused'&&button(L('恢复计划','Resume schedule'),()=>{setPop(null);act('series-resume',{seriesId:s.id},s);},{disabled:busy||blocked||!!unavailable,'data-fleet-cal-pop-resume':s.id}),
            ['active','paused'].includes(s.status)&&button(L('编辑系列配置','Edit series config'),()=>{setPop(null);openDialog({kind:'series-config',seriesId:s.id},s);},{disabled:busy||blocked,'data-fleet-cal-pop-edit':s.id}),
            ['active','paused'].includes(s.status)&&button(L('删除计划','Delete schedule'),()=>{setPop(null);openDialog({kind:'series-delete',seriesId:s.id,name:s.name||s.id},s);},{disabled:busy||blocked||!!unavailable,className:'fl-btn fl-btn-danger','data-fleet-cal-pop-delete':s.id}),
            h('p',{className:'fl-cal-hint'},L('要修改钟点或时区，请在 DSH「自动化任务」中找到同名计划。','To change the time or time zone, find this schedule in DSH’s scheduled task manager.')))));
      // Clamp vertically after mount so the popover never leaves the viewport.
      popNode=h(PopClamp,{key:'pop',children:popNode});
    }
    return h('div',null,
      h('div',{className:'fl-cal-head'},
        h('div',null,h('h2',null,L('计划','Schedules')),h('p',{className:'fl-help'},L('按宿主原生定时任务的时间规则展示；点任一期次查看详情。','Projected from the host schedule rules; click an occurrence for details.'))),
        h('div',{className:'fl-cal-tools'},
          h('div',{className:'fl-cal-nav'},
            button('‹',()=>shift(-1),{'aria-label':L('上一段','Previous'),'data-fleet-cal-prev':''}),
            button(L('今天','Today'),()=>{setPop(null);setAnchor(new Date());},{'data-fleet-cal-today':''}),
            button('›',()=>shift(1),{'aria-label':L('下一段','Next'),'data-fleet-cal-next':''})),
          h('span',{className:'fl-cal-range','data-fleet-cal-range':''},rangeText),
          h('div',{className:'fl-segment',role:'group','aria-label':L('视图','View')},
            ...[['month',L('月','Month')],['week',L('周','Week')],['day',L('日','Day')]].map(([v,label])=>
              h('button',{type:'button',key:v,'aria-pressed':String(view===v),'data-fleet-cal-view':v,onClick:()=>{setPop(null);setView(v);}},label))))),
      h('div',{className:'fl-cal-view','data-fleet-cal':view},body,
        h('div',{className:'fl-cal-legend'},
          ...[[null,L('待执行','Upcoming')],['done',L('已建票','Started')],['failed',L('失败','Failed')],['paused',L('已暂停','Paused')],[null,L('已结束','Ended')]].map(([tone,label],i)=>
            h('span',{key:i},h('i',{className:'fl-dot',...(tone?{'data-tone':tone}:{})}),label)))),
      popNode);
  }
  // Vertical clamp wrapper: measures the mounted popover and keeps it inside the viewport.
  function PopClamp({children}){
    const ref=React.useRef(null);
    React.useLayoutEffect(()=>{const el=ref.current?.firstChild;if(!el)return;const hgt=el.offsetHeight;const top=Math.max(12,Math.min(132,window.innerHeight-hgt-12));el.style.top=top+'px';},[]);
    return h('div',{ref},children);
  }
  // Collapsed management list keeps every existing series action and occurrence table.
  function AllSeries({L,items,ui,setUI,act,busy,navigate,openDialog,unavailable}){
    const [open,setOpen]=React.useState(!!ui.scheduleId);
    React.useEffect(()=>{if(ui.scheduleId)setOpen(true);},[ui.scheduleId]);
    const latestOccurrence=series=>list(series.occurrences).slice().sort((a,b)=>String(b.occurrenceAt).localeCompare(String(a.occurrenceAt)))[0]||null;
    return h('details',{className:'fl-cal-allseries',open,'data-fleet-allseries':'',onToggle:e=>setOpen(e.currentTarget.open)},
      h('summary',null,`${L('全部计划','All schedules')} (${items.length})`),
      items.some(s=>!s.triggerSeriesId)&&h('p',{className:'fl-help fl-spaced'},L('要修改定时计划的钟点或时区，请在 DSH「自动化任务」中找到同名计划。','To change a timed schedule’s time or time zone, find it by name in DSH’s scheduled task manager.')),
      items.length?h('div',{className:'fl-stack'},...items.map(series=>{
        const zone=seriesZone(series),expanded=ui.scheduleId===series.id,last=latestOccurrence(series);
        const source=seriesSource(series);
        const nextRun=series.triggerSeriesId&&series.status==='paused'?L('已暂停','Paused'):series.triggerSeriesId&&series.status==='active'?L('随上游建票','On upstream occurrence'):series.status==='ended'?L('已结束','Ended'):series.status==='orphaned'?L('停止建票','Ticket creation stopped'):zoneTimestamp(nextSeriesTime(series),zone,L);
        return h('article',{className:'fl-schedrow','data-fleet-series':series.id,key:series.id},
          h('div',{className:'fl-row fl-between fl-schedmain'},
            h('div',{className:'fl-stack'},
              h('div',{className:'fl-row'},h('strong',{'data-fleet-series-name':series.id},series.name||series.id),badge(L(...(seriesStatusNames[series.status]||[series.status,series.status])),seriesStatusTones[series.status]||'neutral'),badge(seriesRecurrence(series)==='once'?L('一次性','Once'):L('重复','Recurring'),'neutral')),
              h('div',{className:'fl-row fl-small fl-muted'},
                source.kind==='template'
                  ?button(`${L('模板','Template')} · ${source.templateId}${source.templateRevision!=null?` v${source.templateRevision}`:''}`,()=>navigate('orchestration',{flowId:source.templateId}),{className:'fl-btn fl-btn-ghost fl-btn-sm','data-fleet-series-source':series.id})
                  :source.kind==='ticket'
                    ?button(`Ticket · ${source.ticketId}`,()=>navigate('ticket',{ticketId:source.ticketId,nodeId:null}),{className:'fl-btn fl-btn-ghost fl-btn-sm','data-fleet-series-source':series.id})
                    :h('span',null,L('来源未知','Unknown source')),
                series.triggerSeriesId?button(timingSummary(series,L),()=>setUI({scheduleId:series.triggerSeriesId}),{className:'fl-title-button','data-fleet-series-trigger':series.id}):h('span',{'data-fleet-series-timing':series.id},timingSummary(series,L)))),
            h('div',{className:'fl-stack fl-schedmeta'},
              h('span',{className:'fl-small fl-muted'},L('下次执行','Next run')),
              h('span',{'data-fleet-series-next':series.id},nextRun),
              last&&h('span',{className:'fl-small fl-muted','data-fleet-series-last':series.id},`${L('最近一期','Latest')}：${L(...(occurrenceStatusNames[last.status]||[last.status,last.status]))} · ${zoneTimestamp(last.occurrenceAt,zone,L)}`))),
          series.status==='orphaned'&&h('p',{className:'fl-small',role:'status',style:{color:toneColor('attention')}},L('宿主任务已删除，本系列停止建票；期次记录保留。','The host task was deleted; this series no longer creates Tickets. Occurrence records are retained.')),
          h('div',{className:'fl-row fl-spaced'},
            series.status==='active'&&button(L('暂停','Pause'),()=>act('series-pause',{seriesId:series.id}),{disabled:busy||!!unavailable,'data-fleet-series-pause':series.id}),
            series.status==='paused'&&button(L('恢复','Resume'),()=>act('series-resume',{seriesId:series.id}),{disabled:busy||!!unavailable,className:'fl-btn fl-btn-primary','data-fleet-series-resume':series.id}),
            ['active','paused'].includes(series.status)&&button(L('编辑系列配置','Edit series config'),()=>openDialog({kind:'series-config',seriesId:series.id}),{disabled:busy,'data-fleet-series-edit':series.id}),
            ['active','paused'].includes(series.status)&&button(L('删除','Delete'),()=>openDialog({kind:'series-delete',seriesId:series.id,name:series.name||series.id}),{disabled:busy||!!unavailable,className:'fl-btn fl-btn-danger','data-fleet-series-delete':series.id}),
            button(expanded?L('收起期次','Hide occurrences'):L('期次记录','Occurrences'),()=>setUI({scheduleId:expanded?null:series.id}),{className:'fl-btn fl-btn-ghost','aria-expanded':expanded,'data-fleet-series-expand':series.id})),
          expanded&&h('div',{className:'fl-table-scroll','data-fleet-series-occurrences':series.id},
            list(series.occurrences).length?h('table',null,
              h('thead',null,h('tr',null,...[L('预定时间','Scheduled'),L('实际创建','Created'),L('状态','Status'),L('Ticket','Ticket')].map(label=>h('th',{key:label,scope:'col'},label)))),
              h('tbody',null,...list(series.occurrences).slice().sort((a,b)=>String(b.occurrenceAt).localeCompare(String(a.occurrenceAt))).map(occ=>h('tr',{key:occ.occurrenceAt,'data-fleet-occurrence':occ.occurrenceAt},
                h('td',null,zoneTimestamp(occ.occurrenceAt,zone,L)),
                h('td',null,occ.createdAt?zoneTimestamp(occ.createdAt,zone,L):'—'),
                h('td',null,badge(L(...(occurrenceStatusNames[occ.status]||[occ.status,occ.status])),occ.status==='started'?'success':occ.status==='waiting'?'waiting':'danger'),occ.error&&h('p',{className:'fl-small fl-muted','data-fleet-occurrence-error':occ.occurrenceAt},occ.error)),
                h('td',null,occ.ticketId?button(occ.ticketId,()=>navigate('ticket',{ticketId:occ.ticketId,nodeId:null}),{className:'fl-btn fl-btn-ghost fl-mono','data-fleet-occurrence-ticket':occ.ticketId}):'—')))))
              :h('p',{className:'fl-help'},L('尚无期次记录。','No occurrences yet.'))));
      }))
        :h('p',{className:'fl-help fl-spaced'},L('还没有计划。在任务草稿或编排模板详情里「安排执行」即可创建。','No schedules yet. Use “Schedule” on a Ticket draft or an orchestration template.')));
  }
  function schedulesView(o) {
    const {L,data,ui,setUI,act,busy,navigate,openDialog}=o;
    const state=data.series;
    if(!state)return h('section',{className:'fl-card fl-card-pad','data-fleet-schedules':''},h('div',{className:'fl-row fl-between'},h('h2',null,L('计划','Schedules')),badge(0)),h('p',{className:'fl-help'},L('当前后端未提供计划数据。','The backend does not expose schedule data yet.')));
    const unavailable=scheduleUnavailableReason(data,L);
    const items=list(state.items);
    return h('section',{'data-fleet-schedules':''},
      unavailable&&h('p',{className:'fl-notice',role:'alert','data-fleet-schedule-unavailable':''},unavailable),
      h(ScheduleCalendar,{L,items,act,busy,navigate,openDialog,unavailable}),
      h(AllSeries,{L,items,ui,setUI,act,busy,navigate,openDialog,unavailable}));
  }
  function referencePicker(label,selected,choices,update,L) {
    const remaining=choices.filter(item=>!selected.includes(item.id));
    return h('div',{className:'fl-stack'},h('label',{className:'fl-field'},label,
      h('select',{value:'',onChange:event=>event.target.value&&update([...selected,event.target.value])},
        h('option',{value:''},L('选择…','Select…')),...remaining.map(item=>h('option',{key:item.id,value:item.id},item.label)))),
      selected.length>0&&h('div',{className:'fl-row'},...selected.map(id=>h('span',{key:id,className:'fl-chip'},choices.find(choice=>choice.id===id)?.label||id,
        button('×',()=>update(selected.filter(item=>item!==id)),{className:'fl-btn fl-btn-ghost fl-btn-sm','aria-label':L(`移除 ${id}`,`Remove ${id}`)})))));
  }
  function dependencyFields({L,data,ticketId,seriesId,form,onChange}) {
    const tickets=list(data?.tickets).filter(item=>item.id!==ticketId&&!isIncompatibleDraft(item)).map(item=>({id:item.id,label:`${ticketTitle(item)} · ${item.id}`}));
    const series=list(data?.series?.items).filter(item=>item.id!==seriesId).map(item=>({id:item.id,label:`${item.name||item.id} · ${item.id}`}));
    const pick=(owner,change)=>h('div',{className:'fl-dep-pickers'},
      referencePicker(L('上游 Ticket','Upstream Tickets'),owner.ticketDependencies,tickets,ids=>change({ticketDependencies:ids}),L),
      referencePicker(L('每期匹配上游系列','Match upstream series per occurrence'),owner.ticketDependencySeries,series,ids=>change({ticketDependencySeries:ids}),L));
    return h('div',{className:'fl-stack'},h('strong',null,L('整张 Ticket','Entire Ticket')),pick(form,patch=>onChange({...form,...patch})),
      ...form.nodes.map((node,i)=>h('details',{key:node.id},h('summary',null,`${L('步骤','Step')} · ${node.id} (${node.ticketDependencies.length+node.ticketDependencySeries.length})`),
        pick(node,patch=>onChange({...form,nodes:form.nodes.map((n,j)=>i===j?{...n,...patch}:n)})))));
  }
  function routingEditor({L,data,plan,ticketId,form,onChange,locked}) {
    const options=list(plan.nodes).map(n=>({id:n.id,label:n.id}));
    const nodeSelect=(label,value,change,empty)=>h('label',{className:'fl-field'},label,h('select',{value,onChange:e=>change(e.target.value)},
      h('option',{value:''},empty||L('选择步骤…','Select a step…')),...options.map(n=>h('option',{key:n.id,value:n.id},n.label))));
    const field=(label,value,change,multiline=false)=>h('label',{className:'fl-field'},label,h(multiline?'textarea':'input',{value,onChange:e=>change(e.target.value)}));
    const updateGate=(i,patch)=>onChange({...form,gates:form.gates.map((g,j)=>i===j?{...g,...patch}:g)});
    const addRoute=()=>({id:'',to:[],path:'',operator:'exists',operand:''});
    const operators={exists:L('存在','Exists'),eq:'=',ne:'≠',gt:'>',gte:'≥',lt:'<',lte:'≤'};
    return h('fieldset',{className:'fl-stack fl-routing',disabled:locked},dependencyFields({L,data,ticketId,form,onChange}),
      h('h3',null,L('逻辑关卡','Logic gates')),
      ...form.gates.map((gate,i)=>h('fieldset',{key:i,className:'fl-stack'},h('legend',null,gate.id||L('新关卡','New gate')),
        field(L('关卡 ID','Gate ID'),gate.id,id=>updateGate(i,{id})),nodeSelect(L('交接数据来源步骤','Handoff source step'),gate.from,from=>updateGate(i,{from})),
        ...gate.routes.map((route,j)=>{
          const update=patch=>updateGate(i,{routes:gate.routes.map((r,k)=>k===j?{...r,...patch}:r)});
          return h('fieldset',{key:j,className:'fl-stack'},h('legend',null,route.id||L('新路线','New route')),
            field(L('路线 ID','Route ID'),route.id,id=>update({id})),referencePicker(L('命中后执行步骤','Steps to run on match'),route.to,options,to=>update({to}),L),
            field(L('交接数据路径（每行一级键名）','Handoff path (one key per line)'),route.path,path=>update({path}),true),
            h('label',{className:'fl-field'},L('条件','Condition'),h('select',{value:route.operator,onChange:e=>update({operator:e.target.value})},...Object.entries(operators).map(([key,label])=>h('option',{key,value:key},label)))),
            route.operator!=='exists'&&field(L('比较值（如 5、true 或 "下降"）','Comparison value (e.g. 5, true or "decline")'),route.operand,operand=>update({operand})),
            button(L('移除路线','Remove route'),()=>updateGate(i,{routes:gate.routes.filter((_,k)=>j!==k)})));
        }),row(button(L('添加路线','Add route'),()=>updateGate(i,{routes:[...gate.routes,addRoute()]})),button(L('移除关卡','Remove gate'),()=>onChange({...form,gates:form.gates.filter((_,j)=>j!==i)}))))),
      row(button(L('添加逻辑关卡','Add logic gate'),()=>onChange({...form,gates:[...form.gates,{id:'',from:'',routes:[addRoute()]}]}))),
      form.bindings.length>0&&h('h3',null,L('交付项的执行条件','Deliverable requirements')),
      ...form.bindings.map((binding,i)=>{const item=plan.deliverables[i];return h('div',{key:i},nodeSelect(typeof item==='string'?item:item.title||item.text,binding,id=>onChange({...form,bindings:form.bindings.map((old,j)=>i===j?id:old)}),L('整票必交','Always required')));}));
  }
  // 系列配置编辑（series-update）：只提交本次修改的顶层 plan 字段，整字段替换＋series CAS。
  function SeriesConfigForm({L,data,series,busy,error,onSubmit,onCancel}) {
    const [original]=React.useState(series);
    const plan=original.plan||{};
    const lines=value=>String(value||'').split('\n').map(x=>x.trim()).filter(Boolean);
    const [goal,setGoal]=React.useState(plan.goal||'');
    const [references,setReferences]=React.useState(()=>routingFields(plan));
    const [criteriaText,setCriteriaText]=React.useState(list(plan.criteria).join('\n'));
    const [requirements,setRequirements]=React.useState(typeof plan.requirements==='string'?plan.requirements:'');
    const [deliverablesText,setDeliverablesText]=React.useState(JSON.stringify(list(plan.deliverables),null,2));
    const [inputsText,setInputsText]=React.useState(Object.keys(plan.inputs||{}).length?JSON.stringify(plan.inputs,null,2):'');
    const [localError,setLocalError]=React.useState(null);
    const [submitting,setSubmitting]=React.useState(false);
    const locked=busy||submitting;
    async function submit(event){
      event.preventDefault();
      if(locked)return;
      if(!goal.trim()){setLocalError(L('请填写任务目标。','Please enter a goal.'));return;}
      const fields={};
      if(goal.trim()!==(plan.goal||''))fields.goal=goal.trim();
      const criteria=lines(criteriaText);
      if(JSON.stringify(criteria)!==JSON.stringify(list(plan.criteria)))fields.criteria=criteria;
      const requirementsValue=requirements.trim();
      if(requirementsValue!==(typeof plan.requirements==='string'?plan.requirements:''))fields.requirements=requirementsValue;
      try{const value=JSON.parse(deliverablesText);if(!Array.isArray(value))throw new Error();if(JSON.stringify(value)!==JSON.stringify(list(plan.deliverables)))fields.deliverables=value;}catch{setLocalError(L('交付物须为 JSON 数组。','Enter a JSON array of deliverables.'));return;}
      if(inputsText.trim()){
        let inputs;try{inputs=JSON.parse(inputsText);}catch{setLocalError(L('输入 JSON 格式有误。','Inputs JSON is invalid.'));return;}
        if(!inputs||typeof inputs!=='object'||Array.isArray(inputs)){setLocalError(L('输入须为 JSON 对象。','Inputs must be a JSON object.'));return;}
        if(JSON.stringify(inputs)!==JSON.stringify(plan.inputs||{}))fields.inputs=inputs;
      }else if(Object.keys(plan.inputs||{}).length)fields.inputs={};
      for(const key of referenceKeys)if(JSON.stringify(list(plan[key]))!==JSON.stringify(references[key]))fields[key]=references[key];
      const nodes=list(plan.nodes).map((node,i)=>{const next={...node};writeReferenceFields(next,references.nodes[i]);return next;});
      if(JSON.stringify(references.nodes)!==JSON.stringify(routingFields(plan).nodes))fields.nodes=nodes;
      if(!Object.keys(fields).length){setLocalError(L('没有检测到修改。','No changes detected.'));return;}
      setLocalError(null);setSubmitting(true);
      try{await onSubmit({seriesId:series.id,expectedRevision:original.revision,fields});}
      finally{setSubmitting(false);}
    }
    return h('form',{onSubmit:submit,'data-fleet-series-config-form':series?.id||''},h('div',{className:'fl-stack'},
      h('p',{className:'fl-help'},series.triggerSeriesId?timingSummary(series,L):L('只推广本次修改的字段到系列配置；随后创建的期次继承新版本，已启动期次不受影响。时间规则归宿主原生管理。','Only the fields changed here are promoted to the series configuration; future occurrences inherit the new version and started Tickets are unaffected. Timing stays with the host native manager.')),
      h('label',{className:'fl-field'},L('任务目标','Goal'),h('textarea',{value:goal,disabled:locked,rows:3,required:true,'data-fleet-series-goal':'',onChange:e=>setGoal(e.target.value)})),
      h('label',{className:'fl-field'},L('交付物（JSON 数组）','Deliverables (JSON array)'),h('textarea',{value:deliverablesText,disabled:locked,rows:3,'data-fleet-series-deliverables':'',onChange:e=>setDeliverablesText(e.target.value)})),
      h('label',{className:'fl-field'},L('整单验收标准（每行一条）','Ticket-wide criteria (one per line)'),h('textarea',{value:criteriaText,disabled:locked,rows:3,'data-fleet-series-criteria':'',onChange:e=>setCriteriaText(e.target.value)})),
      h('label',{className:'fl-field'},L('补充要求','Requirements'),h('textarea',{value:requirements,disabled:locked,rows:2,'data-fleet-series-requirements':'',onChange:e=>setRequirements(e.target.value)})),
      h('label',{className:'fl-field'},L('输入（JSON 对象，可空）','Inputs (JSON object, optional)'),h('textarea',{value:inputsText,disabled:locked,rows:3,'data-fleet-series-inputs':'',onChange:e=>setInputsText(e.target.value)})),
      h('details',null,h('summary',null,L('上游依赖','Upstream dependencies')),h('fieldset',{className:'fl-routing',disabled:locked},dependencyFields({L,data,seriesId:series.id,form:references,onChange:setReferences}))),
      (localError||error)&&h('p',{className:'fl-notice',role:'alert','data-fleet-series-config-error':''},localError||error),
      h('div',{className:'fl-dialog-actions'},
        onCancel&&button(L('取消','Cancel'),onCancel,{className:'fl-btn fl-btn-ghost',disabled:submitting}),
        button(submitting?L('正在保存…','Saving…'):L('保存到系列','Save to series'),undefined,{type:'submit',className:'fl-btn fl-btn-primary',disabled:locked,'data-fleet-series-config-submit':''}))));
  }
  function languageSelect(o) {
    const L=language(o);
    return h('label',{className:'fl-language'},h('span',null,L('语言','Language')),
      h('select',{'data-fleet-language-select':'','aria-label':L('界面语言','Interface language'),value:o.languagePreference||'auto',onChange:event=>o.setLanguagePreference(event.target.value)},
        h('option',{value:'auto'},L('跟随 DSH','Follow DSH')),h('option',{value:'zh'},'中文'),h('option',{value:'en'},'English')));
  }

  function Modal({title,children,onClose,busy,L,inPane=false,restoreListFocus=false}) {
    const ref = React.useRef(null);
    React.useEffect(()=>{
      const element=ref.current,doc=element.ownerDocument;
      const previousFocus=doc.activeElement;
      const surface=restoreListFocus?element.closest('.fl-content'):null;
      if(inPane)element.show();else element.showModal();
      return()=>{
        element.close();
        if(previousFocus?.isConnected){previousFocus.focus();return;}
        if(!surface?.isConnected||doc.activeElement!==doc.body)return;
        const fallback=surface.querySelector('.fl-search')||surface.querySelector('[data-fleet-grouped-list] [data-fleet-draft-menu], [data-fleet-grouped-list] [data-open-ticket]')||surface.querySelector('[data-fleet-tab="tickets"]');
        fallback?.focus();
      };
    },[]);
    return h('dialog',{ref,className:inPane?'fl-dialog fl-pane-editor':'fl-dialog','aria-labelledby':'fleet-dialog-title',onKeyDown:inPane?event=>{if(event.key==='Escape'&&!busy&&!ref.current?.querySelector('.fl-popout'))onClose();}:undefined,onCancel:event=>{event.preventDefault();if(!busy)onClose();}},
      h('div',{className:'fl-dialog-head'},h('h2',{id:'fleet-dialog-title'},title),button('×',onClose,{'aria-label':L('关闭','Close'),disabled:busy,className:'fl-btn fl-btn-ghost'})),children);
  }

  function metric(label,value,description,attributes={}) {
    return h('article',{className:'fl-card fl-metric'},h('div',{className:'fl-muted fl-small'},label),h('strong',attributes,value),h('p',null,description));
  }
  // Dashboard redesign v0.1: status-grouped dense list / board helpers (no priority field).
  const GROUP_ORDER=['waiting','attention','running','draft','delivered','stopped'];
  const groupOf=t=>hasIssues(t)?'attention':waiting(t).length||waitingUpstream(t)?'waiting':t.status==='running'?'running':t.status==='draft'?'draft':t.status==='delivered'?'delivered':'stopped';
  const groupLabel=(k,L)=>({waiting:L('等待中','Waiting'),attention:L('待处理问题','Needs attention'),running:L('进行中','In progress'),draft:L('草稿','Draft'),delivered:L('已交付','Delivered'),stopped:L('已停止','Stopped')}[k]);
  const toneColor=k=>({waiting:'var(--fl-waiting)',attention:'var(--fl-danger)',running:'var(--fl-running)',delivered:'var(--fl-success)'}[k]||'var(--fl-muted)');
  const pips=nodes=>h('span',{className:'fl-pips','aria-hidden':true},...list(nodes).map((n,i)=>h('i',{key:i,'data-s':n.status||'pending'})));
  function avstack(nodes,agents) {
    const assigned = list(nodes).filter(node=>node.agentId);
    const ids = [...new Set(assigned.map(node=>node.agentId))];
    return h('span',{className:'fl-avstack'},...ids.slice(0,4).map(id=>{
      const work = assigned.filter(node=>node.agentId===id);
      const active = ['failed','interrupted','running','waiting'].find(state=>work.some(node=>node.status===state));
      const tone = active ? (active==='waiting'?'waiting':tones[active]) : work.every(node=>node.status==='completed')?'success':'neutral';
      const label = agents?.[id]?.name || id;
      return h('span',{key:id,className:'fl-avatar','data-tone':tone,title:label},Array.from(label)[0]);
    }));
  }
  function groupedTickets(tickets,o) {
    const {L,navigate}=o;
    const groups=GROUP_ORDER.map(k=>({k,items:tickets.filter(t=>groupOf(t)===k)})).filter(g=>g.items.length);
    if(!groups.length)return empty(o.ui?.query?L('没有匹配的任务','No matching Tickets'):L('这个工作区还没有任务','No Tickets in this workspace'));
    return h('div',{className:'fl-glist','data-fleet-grouped-list':''},...groups.map(g=>h(React.Fragment,{key:g.k},
      h('div',{className:'fl-ghead'},h('span',{className:'fl-dot',style:{color:toneColor(g.k)}}),groupLabel(g.k,L),h('span',{className:'fl-count'},g.items.length)),
      ...g.items.map(t=>{
        const incompatible=isIncompatibleDraft(t);
        const actions=incompatible||canDeleteDraft(t)?draftActions(t,o,incompatible):null;
        const title=ticketTitle(t);
        const content=[h('span',{className:'fl-ttl',title},h('strong',null,title)),
          incompatible&&incompatibleBadge(t,L),
          h('span',{className:'fl-small fl-muted fl-upd'},timestamp(t.updatedAt||list(t.events).at(-1)?.time,L))];
        const main=incompatible
          ? h('div',{className:'fl-grow fl-grow-notice'},...content)
          : h('button',{type:'button',className:'fl-grow','data-open-ticket':t.id,onClick:()=>navigate('ticket',{ticketId:t.id,nodeId:null})},...content);
        return h('div',{key:t.id,className:'fl-grow-with-actions','data-fleet-ticket':t.id,...(incompatible?{'data-fleet-incompatible-title':t.id}:{})},
          main,h('div',{className:'fl-grow-actions'},actions));
      }))));
  }
  function ticketBoard(tickets,o) {
    const {L,navigate}=o;
    return h('div',{className:'fl-kanban','data-fleet-board':''},...['waiting','attention','running','delivered'].map(k=>{
      const items=tickets.filter(t=>groupOf(t)===k);
      return h('div',{className:'fl-kcol',key:k},h('div',{className:'fl-khead'},h('span',{className:'fl-dot',style:{color:toneColor(k)}}),groupLabel(k,L),h('span',{className:'fl-count fl-muted'},items.length)),
        ...items.map(t=>h('button',{key:t.id,type:'button',className:'fl-card fl-kcard','data-fleet-ticket':t.id,'data-open-ticket':t.id,onClick:()=>navigate('ticket',{ticketId:t.id,nodeId:null})},
          h('span',{className:'fl-row fl-between'},h('span',{className:'fl-mono fl-muted fl-small'},t.id),h('span',{className:'fl-badge','data-tone':{waiting:'waiting',attention:'danger',running:'running',delivered:'success'}[k]},groupLabel(k,L))),
          h('h3',null,ticketTitle(t)),h('div',{className:'fl-row fl-between'},avstack(t.nodes,t.snapshot?.agents||t.plan?.agents),pips(t.nodes)))));
    }));
  }
  const canDeleteDraft=ticket=>ticket?.status==='draft'&&!ticket.execution;
  const ticketTitle=ticket=>[ticket.title,ticket.plan?.title,readableTitle(ticket.goal??ticket.plan?.goal),readableTitle(ticket.plan?.ticket?.goal)].find(value=>typeof value==='string'&&value.trim())||ticket.id;
  function draftActions(ticket,o,incompatible) {
    const {L,busy,openDialog}=o;
    const title=ticketTitle(ticket);
    const choose=action=>event=>{
      const menu=event?.currentTarget.closest('details');
      if(menu){menu.open=false;menu.querySelector('summary')?.focus();}
      return action();
    };
    const item=(label,action,props)=>button(label,choose(()=>{if(!props.disabled)return action();}),{className:'fl-btn fl-btn-ghost',...props});
    return h('details',{className:'fl-draft-menu',onBlur:event=>{
      if(!event.currentTarget.contains(event.relatedTarget))event.currentTarget.open=false;
    },onKeyDown:event=>{
      const menu=event.currentTarget;
      if(event.key==='Escape'&&menu.open){event.stopPropagation();menu.open=false;menu.querySelector('summary')?.focus();}
    }},
      h('summary',{'data-fleet-draft-menu':ticket.id,className:'fl-btn fl-btn-ghost','aria-label':L(`草稿「${title}」的操作`,`Actions for draft “${title}”`)},L('操作','Actions')),
      h('div',{className:'fl-draft-options'},
        incompatible&&item(L('查看旧草稿','Preview old draft'),()=>openDialog({kind:'preview',ticketId:ticket.id}),{'data-fleet-incompatible-preview':ticket.id}),
        incompatible&&item(L('在新对话中重新生成','Recreate in new chat'),()=>o.recreateDraft(ticket),{'data-fleet-recreate-draft':ticket.id,disabled:!!(o.creatingTicket||busy)||typeof o.recreateDraft!=='function'}),
        canDeleteDraft(ticket)&&item(L('删除草稿','Delete draft'),()=>openDialog({kind:'draft-delete',ticketId:ticket.id,expectedRevision:ticket.revision,title}),{'data-fleet-draft-delete':ticket.id,className:'fl-btn fl-btn-ghost fl-btn-danger',disabled:busy})));
  }
  const incompatibleBadge=(ticket,L)=>h('span',{className:'fl-badge','data-tone':'waiting','data-fleet-incompatible-draft':ticket.id},L('不兼容','Incompatible'));
  const recreateHelp=L=>h('p',{className:'fl-help'},L('新对话会携带原始需求。发送预填请求后生成兼容草稿，原草稿保留。','The new chat carries the original needs. Send the prefilled request to generate a compatible draft; the original draft is preserved.'));
  function recreateDraftButton(ticket,o) {
    const L=o.L||language(o),disabled=!!(o.creatingTicket||o.busy)||typeof o.recreateDraft!=='function';
    return button(L('在新对话中重新生成','Recreate in new chat'),()=>{if(!disabled)return o.recreateDraft(ticket);},{'data-fleet-recreate-draft':ticket.id,disabled});
  }
  function ticketLink(ticket,o,{label=ticketTitle(ticket),onOpen,marker=false,...props}={}) {
    if(isIncompatibleDraft(ticket))return h('div',{...props,className:'fl-stack'},h('strong',{'data-fleet-incompatible-title':ticket.id},ticketTitle(ticket)),row(incompatibleBadge(ticket,o.L||language(o)),typeof o.openDialog==='function'&&button(o.L?o.L('查看旧草稿','Preview'):label,()=>o.openDialog({kind:'preview',ticketId:ticket.id}),{'data-fleet-incompatible-preview':ticket.id,className:'fl-btn fl-btn-ghost'}),recreateDraftButton(ticket,o)),recreateHelp(o.L||language(o)));
    return button(label,onOpen||(()=>o.navigate('ticket',{ticketId:ticket.id,nodeId:null})),{className:'fl-title-button',...(marker?{'data-open-ticket':ticket.id}:{}),...props});
  }
  function incompatibleDraftNotice(ticket,o) {
    const L=o.L||language(o);
    const rawGoal=ticket.incompatibleGoal??(typeof ticket.plan?.goal==='string'?ticket.plan.goal:typeof ticket.plan?.ticket?.goal==='string'?ticket.plan.ticket.goal:typeof ticket.goal==='string'&&ticket.goal!==ticketTitle(ticket)?ticket.goal:null);
    const reasons=list(validatePlan(ticket.plan,{mode:'save'}).errors).slice(0,4);
    const agentGates=list(ticket.plan?.gates).filter(gate=>gate?.id&&gate.reviewer?.kind==='agent');
    return h('section',{className:'fl-notice','data-fleet-incompatible-ticket':ticket.id},h('h2',null,L('此草稿不兼容','This draft is incompatible')),h('p',{'data-fleet-incompatible-title':ticket.id},ticketTitle(ticket)),
      rawGoal&&h('div',{className:'fl-spaced'},h('p',{className:'fl-small fl-muted'},L('原始需求','Original request')),h('p',{className:'fl-pre-wrap','data-fleet-incompatible-goal':ticket.id},text(rawGoal))),
      reasons.length>0&&h('div',{className:'fl-spaced'},h('p',{className:'fl-small fl-muted'},L('不兼容原因','Why it is incompatible')),h('ul',{'data-fleet-incompatible-reasons':ticket.id},...reasons.map((r,i)=>h('li',{key:i},`${r.path||'plan'} — ${r.message}`)))),
      ...agentGates.map(gate=>h('details',{key:gate.id,className:'fl-spaced'},h('summary',null,gate.id),gatePlanSections(gate,list(ticket.plan.nodes).find(node=>node?.id===gate.reviewer.nodeId),ticket.plan.agents,o))),
      ticket.originSessionId&&typeof o.openChat==='function'&&h('p',null,button(L('打开来源会话 ↗','Open origin session ↗'),()=>o.openChat(ticket.originSessionId),{className:'fl-btn fl-btn-ghost','data-fleet-incompatible-origin':ticket.id})),
      h('div',{className:'fl-row fl-spaced'},incompatibleBadge(ticket,L),
        ticket.abandonedAt ? badge(L('已放弃执行','Abandoned')) : recreateDraftButton(ticket,o),
        ticket.abandonedAt && typeof o.act==='function' && button(L('恢复此 Ticket','Restore Ticket'),()=>o.act('unabandon',{ticketId:ticket.id,expectedRevision:ticket.revision}),{disabled:o.busy}),
        !ticket.abandonedAt && typeof o.openDialog==='function' && button(L('放弃执行','Abandon execution'),()=>o.openDialog({kind:'abandon',ticketId:ticket.id,expectedRevision:ticket.revision}),{disabled:o.busy,className:'fl-btn fl-btn-danger'})),
      !ticket.abandonedAt&&recreateHelp(L),o.error&&h('p',{role:'alert'},o.error));
  }
  // P-55 first-screen blocker line: the single most important reason this Ticket needs (or is getting) attention.
  function ticketBlocker(ticket,o) {
    const L=o.L||language(o);
    const nodes=list(ticket.nodes),gates=list(ticket.gates);
    const failed=nodes.find(n=>n.status==='failed'),interrupted=nodes.find(n=>n.status==='interrupted');
    const returned=gates.find(g=>g.status==='returned');
    const waits=waiting(ticket),wait=waits.find(g=>g.reviewer?.kind==='human')||waits[0];
    const stale=gates.find(g=>g.status==='passed'&&g.coverage==='stale');
    const running=nodes.find(n=>n.status==='running');
    const goto=nid=>nid?{label:L('查看节点','Open node'),onClick:()=>o.setUI({nodeId:nid,attemptId:null,gateId:null})}:null;
    const canRetry=!ticket.abandonedAt&&['running','stopped'].includes(ticket.status)&&typeof o.openDialog==='function';
    const retry=nid=>canRetry&&nid?button(L('重试节点','Retry node'),()=>o.openDialog({kind:'retry',ticketId:ticket.id,nodeId:nid}),{className:'fl-btn fl-btn-primary','data-fleet-blocker-retry':nid,disabled:o.busy}):null;
    const line=(tone,label,action,extra)=>h('p',{className:'fl-blocker','data-fleet-blocker':ticket.id,'data-tone':tone,style:{color:toneColor(tone)}},h('span',{className:'fl-dot'}),label,action&&button(action.label,action.onClick,{className:'fl-btn fl-btn-ghost','data-fleet-blocker-action':ticket.id}),extra||null);
    if(failed)return line('attention',`${L('执行失败','Failed')} · ${failed.id}`,goto(failed.id),retry(failed.id));
    if(interrupted)return line('attention',`${L('待核对','Interrupted')} · ${interrupted.id}`,goto(interrupted.id),retry(interrupted.id));
    if(returned)return line('attention',`${L('审核退回','Returned')} · ${returned.id}`,goto(list(returned.to)[0]));
    if(stale)return line('attention',`${L('产物已更新，待复核','Artifact updated; re-review needed')} · ${stale.id}`);
    if(wait)return line('waiting',`${L('等待审批','Waiting for review')} · ${wait.id}`);
    if(running)return line('running',`${L('进行中','Running')} · ${running.id}`,goto(running.id));
    if(ticket.status==='delivered')return line('delivered',L('结果已交付','Results delivered'));
    if(waitingUpstream(ticket))return line('waiting',L('已启用自动启动，等待上游交付','Automatic start enabled, awaiting upstream delivery'));
    if(ticket.status==='draft')return line('draft',L('草稿待启动','Draft awaiting start'));
    if(ticket.status==='stop-requested')return line('stopped',L('正在停止','Stopping'));
    if(ticket.status==='stopped')return line('stopped',L('已停止','Stopped'));
    return null;
  }
  function ticketTable(tickets,o) {
    const {L,ui,navigate}=o;
    return h('div',{className:'fl-card fl-table-scroll'},tickets.length ? h('table',null,
      h('thead',null,h('tr',null,...[L('任务','Ticket'),L('执行进度','Progress'),L('状态','Status'),L('最近更新','Updated')].map(label=>h('th',{key:label,scope:'col'},label)))),
      h('tbody',null,...tickets.map(ticket=>h('tr',{key:ticket.id,'data-fleet-ticket':ticket.id},
        h('td',{className:'fl-ticket-title'},ticketLink(ticket,o,{marker:true}),h('p',{className:'fl-mono fl-muted'},ticket.id)),
        h('td',null,ticket.status==='draft'?L('规划草稿','Plan draft'):`${list(ticket.nodes).filter(n=>n.status==='completed').length} / ${list(ticket.nodes).length}`,hasIssues(ticket)&&h('p',{className:'fl-small'},L('有待处理事项','Needs attention'))),
        h('td',null,status(ticket.status,L)),h('td',{className:'fl-small fl-muted'},timestamp(ticket.updatedAt||list(ticket.events).at(-1)?.time,L)))))) : empty(ui.query?L('没有匹配的任务','No matching Tickets'):L('这个工作区还没有任务','No Tickets in this workspace'),button(L('新建任务','New Ticket'),()=>o.openDialog({kind:'prepare'}),{className:'fl-btn fl-btn-primary'})));
  }
  function sessions(o) {
    const {members,sessionMap,openChat,t}=o;
    return h('section',{className:'fl-card fl-card-pad'},row(h('h2',null,t('sessions')),badge(members.length)),
      members.length ? members.slice(0,8).map(id=>h('article',{key:id,className:'fl-session fl-row fl-between','data-fleet-session':id},
        h('div',null,h('h3',null,sessionMap[id].title||t('untitled')),h('p',{className:'fl-mono fl-muted'},id)),button(t('openSession'),()=>openChat(id)))):empty(t('noSessions')),
      h('div',{className:'fl-spaced'},button(t('newSession'),()=>openChat())));
  }
  const activityLabels = {
    'ticket-created':['已创建任务','Ticket created'], 'template-applied':['已应用模板','Template applied'],
    'ticket-started':['已启动任务','Ticket started'], 'ticket-resumed':['已恢复任务','Ticket resumed'],
    'stop-requested':['已请求停止','Stop requested'], 'ticket-stopped':['任务已停止','Ticket stopped'],
    'ticket-delivered':['任务已交付','Ticket delivered'], 'ticket-delivery-recorded':['已记录交付','Delivery recorded'],
    'ticket-abandoned':['已放弃执行','Ticket abandoned'], 'ticket-abandon-reversed':['已撤销放弃','Abandonment reversed'],
    'plan-edited':['已更新计划','Plan edited'], 'plan-repaired':['已修复计划','Plan repaired'],
    'node-claimed':['节点已开始','Node started'], 'node-completed':['节点已完成','Node completed'],
    'node-failed':['节点执行失败','Node failed'], 'node-interrupted':['节点执行中断','Node interrupted'],
    'node-evidence-submitted':['已提交执行证据','Execution evidence submitted'], 'node-retry-requested':['已请求重试','Retry requested'],
    'node-model-changed':['已更新节点模型','Node model updated'], 'node-comment':['已添加节点评论','Node comment added'],
    'gate-review':['已提交关卡审核','Gate review submitted'], 'gate-rework':['已请求返工','Rework requested'],
    'gate-human-override':['已人工放行关卡','Gate approved by override'], 'rework-exhausted':['已用完返工次数','Rework limit reached'],
    'delivery-intent':['已开始交付','Delivery started'], 'delivery-override':['已人工确认交付','Delivery confirmed by override'],
  };
  const activityGroups = {
    'node-failed':'attention','node-interrupted':'attention','gate-rework':'attention','rework-exhausted':'attention',
    'node-completed':'delivered','node-evidence-submitted':'delivered','ticket-delivered':'delivered',
    'ticket-started':'running','ticket-resumed':'running','node-claimed':'running','stop-requested':'waiting',
  };
  function overviewMetric(label,value,unit,tone) {
    return h('article',{className:'fl-metric','data-tone':tone},h('strong',null,value),
      h('div',{className:'fl-muted fl-small'},label),badge([h('span',{key:'dot',className:'fl-dot','aria-hidden':true}),unit],tone));
  }
  function attentionCard(ticket,gate,o) {
    const {L}=o;
    const upstream = new Set(list(gate.from));
    const labels = new Set();
    for (const artifact of Object.values(ticket.artifacts||{})) {
      if (!upstream.has(artifact?.nodeId)) continue;
      const item = list(ticket.deliverables).find(item=>item.index===artifact.deliverableIndex);
      if (item?.label) labels.add(item.label);
    }
    const agentReview = gate.reviewer?.kind==='agent';
    const upstreamNames = list(ticket.nodes).filter(node=>upstream.has(node.id)).map(node=>node.task?.summary||node.role||node.id);
    const reviewTitle = gate.reviewTask?.summary || (upstreamNames.length ? `${L('审核','Review')} · ${upstreamNames.join(' · ')}` : gate.id);
    return h('article',{className:'fl-attention',key:ticket.id+':'+gate.id},
      h('h3',{title:gate.id},h('span',{className:'fl-dot',style:{color:toneColor('waiting')}}),reviewTitle),
      h('p',{className:'fl-muted'},ticketTitle(ticket)),
      h('p',null,agentReview?L('等待智能体审核','Waiting for Agent review'):L('等待人工审批','Waiting for you')),
      labels.size>0&&h('p',{className:'fl-muted'},L('待审交付物','Deliverables for review'),' · ',[...labels].join(' · ')),
      ticketLink(ticket,o,{label:L('去处理','Review'),className:'fl-btn fl-btn-primary'}));
  }
  function overview(o) {
    const {L,data,navigate}=o, tickets=list(data.tickets);
    const approvals=tickets.flatMap(ticket=>waiting(ticket).map(gate=>({ticket,gate})));
    const events=tickets.flatMap(ticket=>list(ticket.events).map(event=>({ticket,event}))).sort((a,b)=>String(b.event.time).localeCompare(String(a.event.time))).slice(0,6);
    return h('div',{className:'fl-overview'},
      h('div',{className:'fl-metrics fl-strip'},
        overviewMetric(L('进行中','In progress'),tickets.filter(t=>t.status==='running').length,L('执行中的任务','Active tickets'),'running'),
        overviewMetric(L('等待决定','Waiting for review'),approvals.length,L('待审核关卡','Review gates'),'waiting'),
        overviewMetric(L('待处理问题','Needs attention'),tickets.filter(hasIssues).length,L('需要处理的任务','Affected tickets'),'danger'),
        overviewMetric(L('已交付','Delivered'),tickets.filter(t=>t.status==='delivered').length,L('累计交付','All time'),'success')),
      h('div',{className:'fl-columns'},h('section',null,
        h('div',{className:'fl-overview-heading'},h('h2',null,L('正在推进','In flight')),button(L('全部任务 →','All Tickets →'),()=>navigate('tickets'),{className:'fl-btn fl-btn-ghost'})),
        groupedTickets(tickets,o)),
        h('aside',{className:'fl-stack'},h('section',null,
          h('div',{className:'fl-overview-heading'},h('h2',null,L('待你处理','Your attention')),badge(approvals.length,'waiting')),
          approvals.length?approvals.slice(0,5).map(({ticket,gate})=>attentionCard(ticket,gate,o)):h('p',{className:'fl-attention-empty','data-fleet-attention-empty':''},L('暂无待审核事项','No reviews waiting'))),
          h('section',null,h('h2',null,L('最近活动','Recent activity')),events.length?events.map(({ticket,event})=>h('article',{className:'fl-timeline',key:event.id},
            h('span',{className:'fl-dot',style:{color:toneColor(activityGroups[event.type])}}),
            h('div',null,h('p',{className:'fl-activity-action',title:event.type},L(...(Object.hasOwn(activityLabels,event.type)?activityLabels[event.type]:['任务已更新','Ticket updated']))),
              h('div',{className:'fl-activity-meta'},isIncompatibleDraft(ticket)?ticketTitle(ticket):ticketLink(ticket,o),' · ',timestamp(event.time,L))))):empty(L('活动会显示在这里','Activity will appear here'))))));
  }
  function ticketsView(o) {
    const {L,ui,data,setUI}=o;
    const query=(ui.query||'').toLowerCase();
    const tickets=list(data.tickets).filter(ticket=>(ui.filter==='all'||!ui.filter||ticket.status===ui.filter)&&`${ticket.id} ${ticketTitle(ticket)} ${ticket.goal}`.toLowerCase().includes(query));
    const board=(ui.ticketsLayout||'list')==='board';
    return h('div',{className:'fl-stack'},h('div',{className:'fl-toolbar'},
      h('input',{className:'fl-search',type:'search',value:ui.query||'',placeholder:L('搜索任务名称或 ID…','Search Tickets…'),'aria-label':L('搜索任务','Search Tickets'),onChange:e=>setUI({query:e.target.value})}),
      h('select',{'aria-label':L('任务状态','Ticket status'),value:ui.filter||'all',onChange:e=>setUI({filter:e.target.value})},h('option',{value:'all'},L('全部状态','All statuses')),...TICKET_STATUSES.map(value=>h('option',{key:value,value},L(...names[value])))),
      h('span',{className:'fl-segment',role:'group','aria-label':L('布局','Layout')},
        h('button',{type:'button','aria-pressed':!board,onClick:()=>setUI({ticketsLayout:'list'})},L('列表','List')),
        h('button',{type:'button','aria-pressed':board,onClick:()=>setUI({ticketsLayout:'board'})},L('看板','Board')))),
      board?ticketBoard(tickets,o):groupedTickets(tickets,o));
  }
  function FlowRegion({o,children}) {
    const {L}=o;
    const [zoom,setZoom]=React.useState(1);
    const [pan,setPan]=React.useState({x:8,y:8});
    const [full,setFull]=React.useState(false);
    const [fit,setFit]=React.useState(true);
    const wrapRef=React.useRef(null),innerRef=React.useRef(null),dragRef=React.useRef(null),supRef=React.useRef(false),closeRef=React.useRef(null);
    const doFit=React.useCallback(()=>{const w=wrapRef.current,inn=innerRef.current;if(!w||!inn)return;const nw=inn.scrollWidth||1,nh=inn.scrollHeight||1;const z=Math.max(0.3,Math.min(1,(w.clientWidth-8)/nw,(w.clientHeight-8)/nh));setZoom(z);setPan({x:8,y:8});},[]);
    React.useEffect(()=>{if(fit)doFit();},[fit,full,doFit]);
    React.useEffect(()=>{const w=wrapRef.current;if(!w||typeof ResizeObserver==='undefined')return;const ro=new ResizeObserver(()=>{if(fit)doFit();});ro.observe(w);return()=>ro.disconnect();},[fit,doFit]);
    React.useEffect(()=>{if(!full)return;const prev=document.activeElement;closeRef.current?.focus();const onKey=e=>{if(e.key==='Escape')setFull(false);};document.addEventListener('keydown',onKey);return()=>{document.removeEventListener('keydown',onKey);if(prev?.isConnected)prev.focus();};},[full]);
    React.useEffect(()=>{const w=wrapRef.current;if(!w)return;const onWheel=e=>{e.preventDefault();e.stopPropagation();setFit(false);setZoom(z=>Math.min(2,Math.max(0.3,z*(e.deltaY<0?1.1:0.9))));};w.addEventListener('wheel',onWheel,{passive:false});return()=>w.removeEventListener('wheel',onWheel);},[full]);
    // One exit path for every way a pan gesture can end (release, cancel, lost capture,
    // window blur). The deferred supRef reset keeps the click that follows pointerup
    // suppressed after a real drag; cancel/blur have no trailing click, so it just clears.
    const endDrag=React.useCallback(pointerId=>{const d=dragRef.current;if(!d)return;if(d.moved)setTimeout(()=>{supRef.current=false;},0);dragRef.current=null;const w=wrapRef.current;if(w){w.dataset.drag='false';const id=pointerId??d.id;if(id!=null&&w.hasPointerCapture?.(id))w.releasePointerCapture?.(id);}},[]);
    React.useEffect(()=>{const onBlur=()=>endDrag();window.addEventListener('blur',onBlur);return()=>window.removeEventListener('blur',onBlur);},[endDrag]);
    const handlers={
      // preventDefault at gesture start stops the browser from building a text selection
      // while the canvas pans; buttons keep their native behavior, focus is kept manually.
      onPointerDown:e=>{if(e.button!==0||dragRef.current||e.target.closest('button'))return;e.preventDefault();e.currentTarget.focus?.({preventScroll:true});dragRef.current={id:e.pointerId,x:e.clientX,y:e.clientY,px:pan.x,py:pan.y,moved:false};e.currentTarget.setPointerCapture?.(e.pointerId);e.currentTarget.dataset.drag='true';},
      onPointerMove:e=>{const d=dragRef.current;if(!d||e.pointerId!==d.id)return;if(!(e.buttons&1)){endDrag(e.pointerId);return;}const dx=e.clientX-d.x,dy=e.clientY-d.y;if(Math.abs(dx)+Math.abs(dy)>4){d.moved=true;supRef.current=true;}setPan({x:d.px+dx,y:d.py+dy});},
      onPointerUp:e=>{if(dragRef.current?.id===e.pointerId)endDrag(e.pointerId);},
      onPointerCancel:e=>{if(dragRef.current?.id===e.pointerId)endDrag(e.pointerId);},
      onLostPointerCapture:e=>{if(dragRef.current?.id===e.pointerId)endDrag(e.pointerId);},
      onClickCapture:e=>{if(supRef.current){e.stopPropagation();e.preventDefault();supRef.current=false;}}
    };
    const ctl=inFull=>h('span',{className:'fl-flowctl'},
      h('button',{type:'button',className:'fl-btn fl-btn-ghost','aria-label':L('缩小','Zoom out'),onClick:()=>{setFit(false);setZoom(z=>Math.max(0.3,z-0.1));}},'−'),
      h('span',{className:'fl-mono fl-small'},Math.round(zoom*100)+'%'),
      h('button',{type:'button',className:'fl-btn fl-btn-ghost','aria-label':L('放大','Zoom in'),onClick:()=>{setFit(false);setZoom(z=>Math.min(2,z+0.1));}},'＋'),
      h('button',{type:'button',className:'fl-btn fl-btn-ghost',onClick:()=>setFit(true)},L('适合','Fit')),
      inFull?h('button',{type:'button',ref:closeRef,className:'fl-btn fl-btn-ghost',onClick:()=>setFull(false)},L('关闭','Close'))
            :h('button',{type:'button',className:'fl-btn fl-btn-ghost',onClick:()=>{setFull(true);setFit(true);}},L('放大查看 ⤢','Fullscreen ⤢')));
    const canvas=h('div',{className:'fl-flow',ref:wrapRef,role:'region','aria-label':L('任务依赖流程','Task dependency flow'),tabIndex:0,...handlers},
      h('div',{className:'fl-flow-inner',ref:innerRef,style:{transform:`translate(${pan.x}px,${pan.y}px) scale(${zoom})`}},children));
    if(full)return h('div',{className:'fl-flowfull',role:'dialog','aria-label':L('任务流程全屏','Task flow fullscreen')},
      h('div',{className:'fl-flowfull-head'},h('strong',null,L('任务流程','Task flow')),h('span',{className:'fl-muted fl-small'},L('拖拽平移 · 滚轮缩放','Drag to pan · wheel to zoom')),h('span',{style:{flex:1}}),ctl(true)),canvas);
    return h('div',{className:'fl-stack'},h('div',{className:'fl-row fl-between'},h('span',{className:'fl-muted fl-small'},L('拖拽平移 · 滚轮缩放','Drag to pan · wheel to zoom')),ctl(false)),canvas);
  }
  function flow(nodes,gates,o,interactive=true,agents={}) {
    const {L,ui,setUI}=o;
    const levels=graphLevels(nodes,gates,o.logicGates);
    const levelOf=id=>levels.findIndex(group=>group.some(node=>node.id===id));
    const display=[];
    levels.forEach((level,index)=>{
      display.push({type:'nodes',items:level,index});
      const gs=gates.filter(gate=>{const froms=list(gate.from).map(levelOf);return froms.length&&froms.every(l=>l>=0)&&Math.max(...froms)===index;});
      if(gs.length)display.push({type:'gates',items:gs,index});
    });
    const columns=display.map((col,ci)=>h('div',{className:'fl-flow-column',key:ci,'data-fleet-flow-level':col.index},
      ...(col.type==='nodes'?col.items.map(node=>h(interactive?'button':'div',{
        type:interactive?'button':undefined,key:node.id,className:'fl-node','data-fleet-node':node.id,
        'aria-pressed':interactive?ui.nodeId===node.id:undefined,onClick:interactive?()=>setUI({nodeId:node.id,attemptId:null,gateId:null}):undefined},
        row(h('span',{className:'fl-row fl-node-title'},h('svg',{className:'fl-ntype-icon fl-ntype-exec',viewBox:'0 0 20 20','aria-hidden':true},h('path',{d:'M4 3 L17 10 4 17 Z',fill:'currentColor'})),h('strong',null,node.id)),node.status==='pending'&&o.nodeDependencyReadiness?.[node.id]?.ready===false?badge(L('等待上游','Waiting for upstream'),'waiting'):status(node.status||'pending',L)),h('p',{className:'fl-muted'},node.role),
        h('p',{className:'fl-node-text','data-fleet-node-summary':node.id},node.task?.summary||firstSentence(node.task?.prompt)||text(node.task||{})),
        modelLine(o,node,agents,L),
        planChips(node.task,L),
        list(node.dependsOn).length>0&&h('p',{className:'fl-small fl-muted'},L('依赖：','Depends on: ')+node.dependsOn.join(', '))))
      :col.items.map(gate=>h(interactive?'button':'div',{type:interactive?'button':undefined,'aria-pressed':interactive?ui.gateId===gate.id:undefined,onClick:interactive?()=>o.selectGate(gate):undefined,className:'fl-node fl-node-gate',key:`gate-${gate.id}`,'data-fleet-gate-node':gate.id},
        row(h('span',{className:'fl-row fl-node-title'},h('svg',{className:'fl-ntype-icon fl-ntype-gate',viewBox:'0 0 20 20','aria-hidden':true},h('path',{d:'M10 2 L16.9 6 L16.9 14 L10 18 L3.1 14 L3.1 6 Z',fill:'currentColor'})),h('strong',null,gate.id)),status(gate.status||'pending',L)),
        h('p',{className:'fl-muted'},gate.reviewer?.kind==='human'?L('人工审批','Human review'):L('审核智能体','Agent review')),
        h('p',{className:'fl-small fl-muted'},`${list(gate.from).join(', ')||'—'} → ${list(gate.to).join(', ')||'—'}`))))));
    return h(FlowRegion,{o},nodes.length?h('div',{className:'fl-flow-columns'},...columns):empty(L('暂无节点','No nodes')));
  }
  const agentDetailHeader=(id,metadata,state,L)=>h('div',{className:'fl-card-head'},
    h('div',null,h('h2',null,id),h('div',{className:'fl-small fl-muted fl-thread-meta',...metadata.attributes},...metadata.parts)),status(state,L));
  function nodeThread(ticket,node,o) {
    const {L,ui,setUI,openChat,openDialog}=o;
    if(!node)return h('section',{className:'fl-card'},empty(L('选择一个节点查看任务与配置','Select a node to inspect its task and configuration')));
    const attempts=list(node.attempts), attempt=attempts.find(a=>a.id===ui.attemptId)||attempts.at(-1);
    const frozen=attempt&&ticket.execution?.configurations?.[attempt.configRevision];
    const historical=attempt?(frozen?projectTicket(ticket,{configRevision:attempt.configRevision}):null):ticket;
    const configuredNode=historical?.nodes?.find(item=>item.id===node.id),profile=historical?.snapshot?.agents?.[configuredNode?.agentId]||(!attempt?ticket.plan?.agents?.[node.agentId]:null);
    // P-44/P-45: three distinct completion facts, derived per selected Attempt — aggregated into one status line (thread-first, 2026-11-19).
    const nodeGates=list(ticket.gates).filter(g=>list(g.from).includes(node.id));
    const acceptanceState=!nodeGates.length?'none':nodeGates.some(g=>g.status==='passed'&&g.coverage==='stale')?'stale':nodeGates.every(g=>g.status==='passed'&&g.coverage==='covered')?'passed':'pending';
    const acceptanceBadge={none:badge(L('无审核关卡','No review gate'),'neutral'),passed:badge(L('已通过','Passed'),'success'),stale:badge(L(...coverageNames.stale),'danger'),pending:badge(L('未通过','Not passed'),'neutral')}[acceptanceState];
    const completion=attempt?.completion;
    const results=list(completion?.acceptanceResults);
    const m=modelDisplay(o,configuredNode||node,historical?.snapshot?.agents||ticket.plan?.agents,L);
    const plannedNode=list(ticket.plan?.nodes).find(n=>n.id===node.id);
    const canEditModel=plannedNode&&(['draft','stopped'].includes(ticket.status)||ticket.status==='running'&&['pending','failed','interrupted','cancelled'].includes(node.status))&&!ticket.execution?.legacy?.readOnly&&validatePlan(ticket.plan,{mode:'save'}).valid;
    const roundText=attempts.length?L(`第 ${Math.max(0,attempts.findIndex(a=>a.id===attempt?.id))+1}/${attempts.length} 轮`,`Round ${Math.max(0,attempts.findIndex(a=>a.id===attempt?.id))+1}/${attempts.length}`):L('未派发','Not dispatched');
    return h('section',{className:'fl-card','data-fleet-thread':node.id},
      agentDetailHeader(node.id,{attributes:{'data-fleet-thread-model':node.id},parts:[`${profile?.name||configuredNode?.agentId||node.role} · `,canEditModel?h(ModelSeat,{key:JSON.stringify([ticket.id,node.id,plannedNode.modelSelection,ticket.plan.agents?.[plannedNode.agentId]?.profile?.modelSelection]),o,ticket,node:plannedNode}):`${m.text}${m.effort?` · ${m.effort}`:''}`,` · ${L(...modelSourceNames[(canEditModel?modelDisplay(o,plannedNode,ticket.plan.agents,L):m).source])} · ${roundText}`]},node.status,L),
      attempt&&h('div',{className:'fl-statusline','data-fleet-completion':attempt.id},
        h('span',null,L('执行','Execution'),badge(attempt.status==='running'?L('执行中','Running'):L('已结束','Execution finished'),attempt.status==='running'?'running':attempt.status==='completed'?'success':'danger')),
        h('span',null,L('证据','Evidence'),completion?badge(L('已提交 · 自报','Submitted · self-reported'),'success'):badge(L('未提交结构化证据','No structured evidence'),'waiting')),
        h('span',null,L('验收','Acceptance'),acceptanceBadge,results.length?h('span',{className:'fl-small fl-muted'},`${results.filter(r=>r.status==='passed').length}/${results.length}`):null)),
      h('div',{className:'fl-thread-context'},attempt&&!frozen?h('p',{className:'fl-small fl-muted'},L('此历史轮次缺少可读取的冻结配置。','The frozen configuration for this attempt is unavailable.')):
        h('p',{className:'fl-summary','data-fleet-thread-summary':node.id},configuredNode?.task?.summary||text(configuredNode?.task?.prompt||node.task)),
        h('div',{className:'fl-row fl-spaced'},
          attempts.length>1&&h('select',{'aria-label':L('执行轮次','Execution attempt'),value:attempt?.id||'',onChange:e=>setUI({attemptId:e.target.value})},...attempts.map((a,i)=>h('option',{key:a.id,value:a.id},`${i+1} · ${L(...names[a.status]||[a.status,a.status])}`))),
          attempt?.sessionId&&button(L('打开完整对话 ↗','Open full conversation ↗'),()=>openChat(attempt.sessionId),{'data-fleet-node-session':attempt.sessionId,className:'fl-btn fl-btn-ghost fl-btn-sm'}),
          !ticket.abandonedAt&&['failed','interrupted','cancelled'].includes(node.status)&&['running','stopped'].includes(ticket.status)&&button(L('重试节点','Retry node'),()=>openDialog({kind:'retry',ticketId:ticket.id,nodeId:node.id})),
          plannedNode?.agentId!=null&&ticket.plan?.agents?.[plannedNode.agentId]&&isCurrentPlan(ticket.plan)&&button(L('保存为 Agent 模板','Save as Agent template'),()=>openDialog({kind:'template-from-node',ticketId:ticket.id,nodeId:node.id}),{disabled:o.busy,'data-fleet-save-agent':node.id}))),
      attempt?.upstreamTickets?.length?upstreamAttempt(attempt,o):upstreamDetails(node,ticket.nodeDependencyReadiness?.[node.id],ticket,o),
      nodePlanSections(configuredNode||node,ticket,{...o,historical:Boolean(attempt&&frozen)}),
      attempt?.error&&h('p',{className:'fl-notice',role:'alert','data-fleet-thread-error':node.id},text(attempt.error)),
      !attempts.length&&h('p',{className:'fl-muted fl-small fl-card-pad'},L('任务派发后，可从“打开完整对话”查看执行进展。','After dispatch, open the full conversation to follow progress.')));
  }
  // Config and evidence details sink to the page-bottom raw data zone (rules 1/2, 2026-11-19).
  function nodeConfigDetails(ticket,node,o) {
    const {L,ui}=o;
    if(!node)return null;
    const attempts=list(node.attempts), attempt=attempts.find(a=>a.id===ui.attemptId)||attempts.at(-1);
    const frozen=attempt&&ticket.execution?.configurations?.[attempt.configRevision];
    const historical=attempt?(frozen?projectTicket(ticket,{configRevision:attempt.configRevision}):null):ticket;
    const configuredNode=historical?.nodes?.find(item=>item.id===node.id),profile=historical?.snapshot?.agents?.[configuredNode?.agentId]||(!attempt?ticket.plan?.agents?.[node.agentId]:null);
    return h('div',{className:'fl-spaced','data-fleet-thread-config':node.id},
      h('details',null,h('summary',null,L('完整任务指令与节点配置','Full task instructions and node config')),
        h('p',{className:'fl-small fl-pre-wrap','data-fleet-thread-prompt':node.id},text(configuredNode?.task?.prompt||configuredNode?.task||node.task)),
        kv('Node ID',node.id),kv('Agent ID',configuredNode?.agentId||L('未分配','Unassigned')),
        kv(L('角色','Role'),configuredNode?.role||'—'),
        kv(L('DSH 预设','DSH preset'),profile?.profile?.agentPreset||L('继承默认','Host default')),
        attempt&&kv(L('配置版本','Configuration revision'),attempt.configRevision),
        profile?.profile?.instructions&&h('div',{className:'fl-spaced'},h('p',{className:'fl-small fl-muted'},L('智能体指令','Agent instructions')),h('p',{className:'fl-small fl-pre-wrap'},text(profile.profile.instructions))))
      ,configuredNode?.task?.contract&&h('details',{className:'fl-spaced'},h('summary',null,L('业务合同（验收／范围／验证）','Task contract (acceptance / scope / verify)')),readValue(configuredNode.task.contract)),
      profile&&h('details',{className:'fl-spaced'},h('summary',null,L('配置与来源','Profile and source')),readValue({profile:profile.profile,sourceRefs:historical?.snapshot?.sourceRefs})));
  }
  function completionEvidenceDetails(ticket,node,o) {
    const {L,ui}=o;
    if(!node)return null;
    const attempts=list(node.attempts), attempt=attempts.find(a=>a.id===ui.attemptId)||attempts.at(-1);
    if(!attempt)return null;
    const completion=attempt?.completion;
    return h('div',{className:'fl-spaced','data-fleet-evidence-details':attempt.id},
      attempt?.outputs!=null&&h('details',null,h('summary',null,L('执行结果原文','Execution result payload')),clampText(attempt.outputs,{'data-fleet-thread-outputs':node.id})),
      completion?h(React.Fragment,null,
        h('p',{className:'fl-small fl-muted'},`${L('完成证据（自报，不代表已核对）','Completion evidence (self-reported, not host-verified)')} · ${timestamp(completion.submittedAt,L)}`),
        completion.summary&&clampText(completion.summary,{'data-fleet-thread-evidence':node.id}),
        evidenceList(L('验收结果','Acceptance results'),list(completion.acceptanceResults).map(r=>h(React.Fragment,null,badge(L(...(acceptanceNames[r.status]||[r.status,r.status])),acceptanceTones[r.status]||'neutral'),' ',r.criterion||L('未注明标准','Unspecified criterion'),r.evidence?h('span',{className:'fl-small fl-muted'},` — ${r.evidence}`):null))),
        list(completion.verification).length>0&&h('div',{className:'fl-stack fl-spaced'},h('p',{className:'fl-small fl-muted'},L('验证记录（Agent 自述，未经宿主验证）','Verification records (agent-reported; not host-verified)')),
          ...list(completion.verification).map((v,i)=>h('div',{key:i,className:'fl-notice'},h('p',{className:'fl-mono'},v.command),h('p',{className:'fl-small'},v.exitCode!==undefined&&badge(`exit ${v.exitCode}`,v.exitCode===0?'success':'danger'),' ',badge(L('Agent 自述','Agent-reported'),'neutral')),v.output?h('pre',{className:'fl-small'},v.output):null))),
        list(completion.artifactRefs).length>0&&h('div',{className:'fl-spaced'},h('p',{className:'fl-small fl-muted'},L('产物版本','Artifact versions')),h('div',{className:'fl-row'},...list(completion.artifactRefs).map((r,i)=>{
          const version=list(ticket.artifacts?.[r.artifactId]?.versions).find(v=>v.version===r.version);
          const target=version?snapshotTarget(o,version.snapshotPath):null;
          const label=`${r.artifactId} · v${r.version} · ${shortHash(r.sha256)}`;
          return target?fileLink(o,target,label,{key:i,className:'fl-btn fl-btn-ghost fl-mono','data-fleet-artifact-link':r.artifactId}):h('span',{key:i,className:'fl-mono fl-small'},label);
        }))),
        completion.handoff&&h('details',{className:'fl-spaced'},h('summary',null,L('交接说明','Handoff')),readValue(completion.handoff)))
        :h('p',{className:'fl-help'},L('该轮次未提交结构化完成证据；执行结束不代表验收通过。','This attempt submitted no structured completion evidence; finished execution is not acceptance.')));
  }
  const waitingUpstream=(ticket)=>ticket.status==='draft'&&Boolean(ticket.dependencyAuthorization)&&ticket.dependencyReadiness?.ready===false;
  const needsSeriesSchedule=(ticket,plan,data)=>planHasSeries(plan)&&!ticketSeries(ticket,data).some(s=>s.role==='occurrence');
  const seriesStartHint=L=>L('请安排执行或跟随上游系列，以便为每期匹配上游 Ticket。','Schedule this draft or follow an upstream series to bind Tickets for each occurrence.');
  function upstreamDetails(owner,readiness,ticket,o) {
    const {L,data}=o;
    const ids=readiness?.ticketIds??[...new Set([...list(owner?.ticketDependencies),...list(owner?.ticketDependencySeries).map(id=>ticket.dependencyBindings?.[id]).filter(Boolean)])];
    const seriesIds=readiness?.waitingSeriesIds??list(owner?.ticketDependencySeries).filter(id=>!ticket.dependencyBindings?.[id]);
    if(!ids.length&&!seriesIds.length)return null;
    return h('div',{className:'fl-stack','data-fleet-upstream':owner.id||ticket.id},
      ...ids.map(id=>{
        const source=list(data?.tickets).find(t=>t.id===id);
        return h('div',{key:id,className:'fl-notice'},h('div',{className:'fl-row'},source?ticketLink(source,o,{label:`${ticketTitle(source)} · ${id}`,'data-fleet-open-upstream':id}):h('code',null,id),
          badge((readiness?!list(readiness.waitingTicketIds).includes(id):source?.status==='delivered')?L('已交付','Delivered'):L('等待上游交付','Awaiting upstream delivery'),(readiness?!list(readiness.waitingTicketIds).includes(id):source?.status==='delivered')?'success':'waiting')),
          ...list(source?.deliverables).map(d=>h('div',{key:d.index,className:'fl-small'},d.label,d.latest&&` · v${d.latest.version}`,d.reviewStatus==='skipped'&&` · ${L('已跳过','Skipped')}`)));
      }),...seriesIds.map(id=>h('div',{key:id,className:'fl-row'},badge(L('等待期次匹配','Awaiting occurrence match'),'waiting'),button(list(data?.series?.items).find(s=>s.id===id)?.name||id,()=>o.navigate('schedules',{scheduleId:id}),{className:'fl-title-button'}))));
  }
  function upstreamAttempt(attempt,o) {
    const {L,data}=o;
    if(!attempt?.upstreamTickets?.length)return null;
    return h('section',{className:'fl-card-pad fl-stack','data-fleet-upstream-attempt':attempt.id},h('h3',null,L('本轮使用的上游交付物','Upstream deliverables used in this attempt')),
      ...attempt.upstreamTickets.map(source=>{const ticket=list(data?.tickets).find(t=>t.id===source.ticketId);
        return h('div',{className:'fl-stack',key:source.ticketId},ticket?ticketLink(ticket,o,{label:`${ticketTitle(ticket)} · ${ticket.id}`,'data-fleet-open-upstream':ticket.id}):source.ticketId,
          ...list(source.deliverables).map(item=>h('div',{key:item.index},h('strong',null,item.label),item.version!=null?h('div',{className:'fl-small'},`v${item.version} · `,h('code',null,item.sha256),fileLink(o,snapshotTarget(o,item.snapshotPath),item.snapshotPath)):badge(L('未绑定','Unbound')))),
          source.overrideReason&&h('p',{className:'fl-help'},source.overrideReason));}));
  }
  function FollowSeries({ticket,data,L,busy,act}) {
    const ids=[...new Set([ticket.plan,...list(ticket.plan?.nodes)].flatMap(owner=>list(owner?.ticketDependencySeries)))];
    const [chosen,setChosen]=React.useState('');
    const trigger=ids.length===1?ids[0]:ids.includes(chosen)?chosen:'';
    if(!ids.length)return null;
    const existing=list(data.series?.items).find(s=>s.triggerSeriesId===trigger&&s.sourceTicketId===ticket.id&&['active','paused'].includes(s.status));
    return h('div',{className:'fl-row'},ids.length>1&&h('label',{className:'fl-field'},L('触发系列','Trigger series'),h('select',{value:trigger,disabled:busy,onChange:e=>setChosen(e.target.value),'data-fleet-follow-trigger':''},
      h('option',{value:''},L('选择触发系列…','Select a trigger series…')),...ids.map(id=>h('option',{key:id,value:id},data.series?.items?.find(s=>s.id===id)?.name||id)))),
      button(existing?L('已跟随上游系列','Following upstream series'):L('跟随上游系列','Follow upstream series'),()=>act('series-follow',{sourceTicketId:ticket.id,triggerSeriesId:trigger,expectedRevision:ticket.revision,name:ticketTitle(ticket)}),{disabled:busy||!trigger||!!existing,'data-fleet-series-follow':ticket.id}));
  }
  function routeResults(ticket,o) {
    const {L}=o;
    return list(ticket.logicGates).map(gate=>h('section',{key:gate.id,className:'fl-card fl-card-pad','data-fleet-logic-gate':gate.id},
      h('h3',null,`${L('逻辑关卡','Logic gate')} · ${gate.id}`),h('p',{className:'fl-help'},`${L('来源步骤','Source step')} · ${gate.from}`),
      ...gate.routes.map(route=>h('details',{key:route.id,className:'fl-spaced','data-fleet-route':route.id},
        h('summary',null,h('strong',null,route.id),route.status==='completed'?badge(L('已执行','Executed'),'success'):route.status==='skipped'&&route.matched===false?badge(L('未命中 · 已跳过','Unmatched · skipped')):status(route.status,L)),
        gate.attemptId&&kv(L('判定所用轮次','Source attempt'),gate.attemptId),
        h('p',{className:'fl-small fl-mono'},`${route.condition.path.map(key=>JSON.stringify(key)).join(' → ')} ${route.condition.operator}${route.condition.operator==='exists'?'':` ${JSON.stringify(route.condition.value)}`}`),
        h('div',{className:'fl-row'},...route.to.map(id=>button(id,()=>o.setUI({nodeId:id,gateId:null,attemptId:null}),{key:id,className:'fl-title-button'})))))));
  }
  function ticketView(o) {
    const {L,data,ui,setUI,navigate,openDialog,act,busy}=o;
    const ticket=list(data.tickets).find(t=>t.id===ui.ticketId);
    if(!ticket)return empty(L('任务已不存在或未能读取','Ticket is no longer available'),button(L('返回任务','Back to Tickets'),()=>navigate('tickets')));
    if(isIncompatibleDraft(ticket))return h('div',{className:'fl-stack'},button(L('← 任务','← Tickets'),()=>navigate('tickets'),{className:'fl-btn fl-btn-ghost'}),incompatibleDraftNotice(ticket,o));
    const validPlan=validatePlan(ticket.plan,{mode:'save'}).valid;
    const draft=ticket.status==='draft',editable=['draft','stopped'].includes(ticket.status);
    const scheduleUnavailable=scheduleUnavailableReason(data,L);
    const nodes=list(ticket.nodes),gates=list(ticket.gates);
    const node=nodes.find(n=>n.id===ui.nodeId)||nodes[0];
    const selectedGate=ui.gateTicketId===ticket.id&&!ui.nodeId?gates.find(g=>g.id===ui.gateId):null;
    const selectGate=gate=>setUI({gateTicketId:ticket.id,gateId:gate.id,nodeId:null,attemptId:null});
    const flowOptions={...o,nodeDependencyReadiness:ticket.nodeDependencyReadiness,logicGates:ticket.logicGates,selectGate,ui:{...ui,nodeId:selectedGate?null:node?.id,gateId:selectedGate?.id}};
    // P-46 delivery projection: registry rows, blocked reasons and the human override exit.
    const deliverables=list(ticket.deliverables),delivery=ticket.delivery;
    const gap=deliveryGapInfo(ticket);
    const settlementBlocked=gap.allCompleted&&gap.allPassed&&gap.blocked;
    const latestDelivery=list(delivery?.history).at(-1);
    const exhaustedEvents=list(ticket.activity).filter(a=>a.type==='rework-exhausted');
    const sources=gate=>reviewSources(ticket,gate);
    const reviewArtifacts=gate=>reviewSourceArtifacts(ticket,gate);
    const subjectLabel=gate=>{
      const artifacts=reviewArtifacts(gate);
      if(!artifacts.length)return list(gate.from).join(', ');
      const [id,first]=artifacts[0];
      return (first.sourcePath||first.label||id)+(artifacts.length>1?' +'+(artifacts.length-1):'');
    };
    const reviewable=gate=>sourcesReady(ticket,gate)&&gate.status!=='skipped'&&ticket.status==='running'&&!ticket.execution?.legacy?.readOnly&&!gate.humanOverride&&(gate.status!=='passed'||['stale','unreviewed'].includes(gate.coverage));
    const humanReview=gate=>reviewable(gate)&&gate.reviewer?.kind==='human';
    const canApprove=gate=>!gate.requireEvidence||sources(gate).filter(n=>n?.status==='completed').every(n=>list(n.attempts).at(-1)?.completion);
    const showSubject=(gate,event)=>{
      const workbench=event.currentTarget.closest('[data-fleet-ticket-card]')?.parentElement;
      selectGate(gate);
      requestAnimationFrame(()=>workbench?.querySelector('[data-fleet-gate-inspector]')?.focus());
    };
    const gateCard=gate=>{
          const passedReview=list(gate.reviews).filter(r=>r.decision==='passed'&&r.cycle===gate.cycle).at(-1);
          const returnedFindings=gate.status==='returned'?list(gate.reviews).filter(r=>r.decision==='returned'&&r.cycle===gate.cycle).flatMap(r=>list(r.findings)):[];
          const override=overrideBinding(ticket,gate);
          const reworkExhausted=gate.rework?.enabled&&!gate.rework.unlimited&&gate.rework.maxRounds>0&&gate.status==='returned'&&gate.rework.autoReworkRounds>=gate.rework.maxRounds;
          const reviewerNode=gate.reviewer?.kind==='agent'?nodes.find(n=>n.id===gate.reviewer.nodeId):null;
          
          if(gate.reviewer.kind==='agent'){
            const agents=ticket.snapshot?.agents||ticket.plan?.agents;
            const model=modelDisplay(o,gate.modelSelection?{...reviewerNode,modelSelection:gate.modelSelection}:reviewerNode,agents,L);
            const source=gate.modelSelection?L('此 Gate 专用','Gate override'):model.source==='node'?L(`继承 ${reviewerNode.id}`,`Inherited from ${reviewerNode.id}`):L(...modelSourceNames[model.source]);
            const executor=reviewerNode?`${agents?.[reviewerNode.agentId]?.name||reviewerNode.agentId||reviewerNode.id} · ${reviewerNode.id}`:L(`审核节点缺失 · ${gate.reviewer.nodeId}`,`Missing reviewer node · ${gate.reviewer.nodeId}`);
            const picker=editable&&validPlan&&!ticket.abandonedAt&&reviewerNode?h(ModelSeat,{key:gate.id,o,ticket,node:reviewerNode,gate}):`${model.text}${model.effort?` · ${model.effort}`:''}`;
            const artifacts=reviewArtifacts(gate).flatMap(([id,artifact])=>{
              const version=list(artifact.versions).at(-1);
              return version?[fileLink(o,snapshotTarget(o,version.snapshotPath),(artifact.sourcePath||artifact.label||id)+' · v'+version.version,{key:id,className:'fl-small','data-fleet-review-artifact':id})]:[];
            });
            const actions=gate.dispatch?.sessionId||reviewable(gate);
            return h('section',{className:'fl-card',tabIndex:-1,'data-fleet-gate-inspector':gate.id,'data-fleet-gate':gate.id},
              agentDetailHeader(gate.id,{attributes:{'data-fleet-gate-header':gate.id},parts:[executor,' · ',picker,' · ',source]},gate.status||'pending',L),
              gate.reviewTask?.summary&&h('div',{className:'fl-thread-context'},h('p',{className:'fl-summary'},gate.reviewTask.summary)),
              gatePlanSections(gate,reviewerNode,agents,o,{compact:true,artifacts:artifacts.length?h('div',{className:'fl-row'},...artifacts):null}),
              (reworkExhausted||gate.coverage==='stale'||actions)&&h('div',{className:'fl-card-pad fl-stack'},
                reworkExhausted&&h('p',{className:'fl-small','data-fleet-rework':gate.id},badge(`${L('自动返工','Auto rework')} ${gate.rework.autoReworkRounds}/${gate.rework.maxRounds}`,'danger'),' ',L('预算耗尽','Budget exhausted')),
                gate.coverage==='stale'&&staleAlert(L),
                gate.dispatch?.sessionId&&button(L('打开完整对话 ↗','Open full conversation ↗'),()=>o.openChat(gate.dispatch.sessionId),{className:'fl-btn fl-btn-ghost fl-btn-sm'}),
                reviewable(gate)&&button(L('人工通过','Pass as human'),()=>openDialog({kind:'pass',ticketId:ticket.id,gateId:gate.id}),{disabled:busy})));
          }
          return h('section',{className:'fl-card fl-card-pad fl-stack',tabIndex:-1,'data-fleet-gate-inspector':gate.id,'data-fleet-gate':gate.id},h('div',{className:'fl-row fl-between'},h('strong',null,`◇ ${gate.id}`),h('span',{className:'fl-row'},status(gate.status||'pending',L),gate.status==='passed'&&coverageNames[gate.coverage]&&h('span',{className:'fl-badge','data-tone':coverageTones[gate.coverage],'data-fleet-gate-coverage':gate.id},L(...coverageNames[gate.coverage])))),
          h('p',{className:'fl-muted'},`${list(gate.from).join(', ')} → ${list(gate.to).join(', ')}`),h('p',null,gate.reviewer.kind==='human'?L('人工审批','Human review'):`${L('审核智能体','Reviewer')}: ${gate.reviewer.nodeId}`),
          ...sources(gate).filter(Boolean).map(n=>{
            const attempt=list(n.attempts).at(-1);
            const summary=attempt?.completion?.summary||attempt?.outputs?.finalText||attempt?.outputs?.text||(typeof attempt?.outputs==='string'?attempt.outputs:'');
            return h('div',{key:n.id},button(n.id+' · '+L('查看节点','Open node'),()=>setUI({nodeId:n.id,gateId:null,attemptId:attempt?.id??null}),{className:'fl-btn fl-btn-ghost fl-btn-sm'}),summary&&clampText(summary));
          }),
          ...reviewArtifacts(gate).map(([id,artifact])=>{
            const version=list(artifact.versions).at(-1);
            return version&&fileLink(o,snapshotTarget(o,version.snapshotPath),(artifact.sourcePath||artifact.label||id)+' · v'+version.version,{key:id,className:'fl-small','data-fleet-review-artifact':id});
          }),
          gate.requireEvidence&&h('p',{className:'fl-small'},badge(L('需要结构化证据','Structured evidence required'),'waiting')),
          gate.rework?.enabled&&h('p',{className:'fl-small','data-fleet-rework':gate.id},gate.rework.unlimited?badge(L('人工退回 · 返工无限次','Human returns · unlimited rework'),'waiting'):badge(`${L('自动返工','Auto rework')} ${gate.rework.autoReworkRounds}/${gate.rework.maxRounds}`,reworkExhausted?'danger':'waiting')),
          reworkExhausted&&h('p',{className:'fl-small'},L('预算耗尽，等待人工决定：手动重试、强制通过或停止。','Budget exhausted; awaiting a human decision: manual retry, force pass or stop.')),
          gate.humanOverride&&h('p',null,override?L(`已记录人工覆盖（针对 ${override.bound||'无当时版本'}，当前 ${override.latest}）`,`Human override recorded (bound ${override.bound||'no version then'}, now ${override.latest})`):L('已记录人工覆盖','Human override recorded')),
          gate.reviewer.kind==='human'&&passedReview?.artifactRefs?.length>0&&h('p',{className:'fl-small fl-muted fl-mono'},`${L('审核版本','Reviewed versions')}: ${passedReview.artifactRefs.map(r=>`${r.artifactId} v${r.version}`).join(' · ')}${passedReview.bindingKind==='auto-latest'?` (${L('自动绑定最新','auto-bound latest')})`:''}`),
          gate.coverage==='stale'&&staleAlert(L),
          gate.reviewer.kind==='human'&&returnedFindings.length>0&&h('div',{className:'fl-spaced'},h('p',{className:'fl-small fl-muted'},L('退回意见','Return findings')),h('ul',null,...returnedFindings.map(f=>h('li',{key:f.id},badge(L(...(severityNames[f.severity]||[f.severity,f.severity])),severityTones[f.severity]||'neutral'),' ',f.description)))),
          gate.reviewer.kind==='human'&&list(gate.reviews).filter(r=>r.cycle===gate.cycle).slice(-1).map(r=>typeof r.evidence==='string'&&clampText(r.evidence)),
          gate.dispatch?.sessionId&&button(L('查看审核对话 ↗','Open review conversation ↗'),()=>o.openChat(gate.dispatch.sessionId)),
          reviewable(gate)&&h('div',{className:'fl-row'},
            button(L('人工通过','Pass as human'),()=>openDialog({kind:'pass',ticketId:ticket.id,gateId:gate.id}),{disabled:busy}),
            humanReview(gate)&&h(React.Fragment,null,
              button(L('审核通过','Review passed'),()=>openDialog({kind:'review',ticketId:ticket.id,gateId:gate.id,decision:'passed'}),{disabled:busy||!canApprove(gate),'data-fleet-review-passed':gate.id}),
              button(L('退回并说明','Return with feedback'),()=>openDialog({kind:'review',ticketId:ticket.id,gateId:gate.id,decision:'returned'}),{disabled:busy}))));
    };
    const isOccurrence=ticketSeries(ticket,data).some(s=>s.role==='occurrence');
    const requiresSchedule=!isOccurrence&&planHasSeries(ticket.plan);
    const dependencyAction=ticket.dependencyAuthorization?'dependency-disable':'dependency-enable';
    const ordinaryDraft=draft&&!ticket.abandonedAt&&!isOccurrence;
    const todoGates=gates.filter(humanReview);
    const gateTodos=todoGates.length>0&&h('div',{className:'fl-todos','data-fleet-todos':ticket.id},...todoGates.map(gate=>
      h('div',{className:'fl-todo fl-row',key:gate.id,'data-fleet-todo':gate.id},
        h('strong',null,L('待你审批','Needs your review')+' · '+gate.id),
        button(L('交付物汇报','Deliverable report')+' · '+subjectLabel(gate),event=>showSubject(gate,event),{className:'fl-btn fl-btn-ghost fl-btn-sm','data-fleet-review-subject':gate.id}),
        button(L('同意','Approve'),()=>openDialog({kind:'review',ticketId:ticket.id,gateId:gate.id,decision:'passed'}),{className:'fl-btn fl-btn-primary fl-btn-sm',disabled:busy||!canApprove(gate),'data-fleet-todo-approve':gate.id}),
        button(L('不同意','Reject'),()=>openDialog({kind:'review',ticketId:ticket.id,gateId:gate.id,decision:'returned'}),{className:'fl-btn fl-btn-sm',disabled:busy,'data-fleet-todo-reject':gate.id}))));
    return h('div',{className:'fl-stack'},!validPlan&&legacyPlan({...o,draft:ticket,onRepair:base=>act('draft-repair',{ticketId:base.id,expectedRevision:base.revision,sessionId:base.originSessionId}),onRegenerate:base=>act('draft-regenerate',{ticketId:base.id,expectedRevision:base.revision,sessionId:base.originSessionId}),onOpenTicket:id=>navigate('ticket',{ticketId:id,nodeId:null})}),
      h('section',{className:'fl-card fl-card-pad','data-fleet-ticket-card':ticket.id},
        h('div',{className:'fl-row fl-between fl-ticket-meta'},row(o.surface==='side-pane'?null:button(L('← 任务','← Tickets'),()=>navigate('tickets'),{className:'fl-btn fl-btn-ghost'}),h('span',{className:'fl-mono fl-muted fl-small'},ticket.id),status(ticket.status,L),ticket.abandonedAt&&badge(L('已放弃执行','Abandoned'),'neutral')),row(
          draft&&validPlan&&!ticket.abandonedAt&&button(L('确认并启动','Confirm and start'),()=>openDialog({kind:'start',ticketId:ticket.id}),{className:'fl-btn fl-btn-primary',disabled:busy||requiresSchedule||ticket.dependencyReadiness?.ready===false,title:requiresSchedule?seriesStartHint(L):undefined}),
           ordinaryDraft&&!requiresSchedule&&!!ticket.plan?.ticketDependencies?.length&&button(ticket.dependencyAuthorization?L('关闭依赖自动启动','Disable automatic start'):L('上游交付后自动启动','Enable start after upstream delivery'),()=>act(dependencyAction,{ticketId:ticket.id,expectedRevision:ticket.revision}),{disabled:busy||(!ticket.dependencyAuthorization&&!validatePlan(ticket.plan,{mode:'start'}).valid),'data-fleet-dependency-action':dependencyAction}),
          draft&&!ticket.abandonedAt&&validatePlan(ticket.plan,{mode:'start'}).valid&&button(L('安排执行','Schedule'),()=>openDialog({kind:'schedule',ticketId:ticket.id}),{disabled:busy||!!scheduleUnavailable,'data-fleet-schedule-entry':ticket.id,title:scheduleUnavailable||L('按固定钟点一次性或周期执行','Run once or recurring at a fixed wall-clock time')}),
          validPlan&&button(editable?L('修改草稿','Edit draft'):L('查看计划','View plan'),()=>openDialog({kind:'revise',ticketId:ticket.id,ticket,ticketRevision:ticket.revision}),{disabled:busy}),
          validPlan&&isCurrentPlan(ticket.plan)&&button(L('保存为编排模板','Save as orchestration template'),()=>openDialog({kind:'template-from-ticket',ticketId:ticket.id}),{disabled:busy,'data-fleet-save-orchestration':ticket.id}),
          ticket.status==='running'&&button(L('停止任务','Stop task'),()=>act('stop',{ticketId:ticket.id}),{disabled:busy,className:'fl-btn fl-btn-danger'}),
          ticket.status==='stopped'&&!ticket.abandonedAt&&button(L('恢复执行','Resume'),()=>act('resume',{ticketId:ticket.id}),{disabled:busy||!validPlan||ticket.dependencyReadiness?.ready===false,className:'fl-btn fl-btn-primary'}),
          ['draft','stopped'].includes(ticket.status)&&(ticket.abandonedAt
            ?button(L('恢复此 Ticket','Restore Ticket'),()=>act('unabandon',{ticketId:ticket.id,expectedRevision:ticket.revision}),{disabled:busy,'data-fleet-unabandon':ticket.id})
            :button(L('放弃执行','Abandon execution'),()=>openDialog({kind:'abandon',ticketId:ticket.id,expectedRevision:ticket.revision}),{disabled:busy,className:'fl-btn fl-btn-danger','data-fleet-abandon':ticket.id})))),
        h('h2',{'data-fleet-ticket-title':ticket.id},ticketTitle(ticket)),
        seriesBadges(ticket,data,L,seriesId=>navigate('schedules',{scheduleId:seriesId}),'ticket'),
        draft&&validPlan&&scheduleUnavailable&&h('p',{className:'fl-help',role:'status','data-fleet-schedule-unavailable':''},scheduleUnavailable),
        gateTodos,
        ticket.goal&&ticketTitle(ticket)!==ticket.goal?h('p',{className:'fl-goal'},text(ticket.goal)):null,
        ticketBlocker(ticket,o),
         ordinaryDraft&&requiresSchedule&&h(FollowSeries,{key:ticket.id,ticket,data,L,act,busy:busy||!validatePlan(ticket.plan,{mode:'start'}).valid}),
         draft&&requiresSchedule&&h('p',{className:'fl-help'},seriesStartHint(L)),
         upstreamDetails(ticket.snapshot||ticket.plan,ticket.dependencyReadiness,ticket,o),

        (deliverables.length>0||delivery?.override||latestDelivery)&&h('div',{className:'fl-spaced','data-fleet-deliverables':ticket.id},
        h('div',{className:'fl-row fl-between'},h('h3',null,L('交付物','Deliverables')),h('span',{className:'fl-small fl-muted'},`${L('交付目录','Delivery target')}：${ticket.inputs?.deliveryTarget||L('Ticket 交付区','Ticket delivery area')}`)),
        deliverables.length?h('div',{className:'fl-dlist','data-fleet-deliverable-list':''},...deliverables.map(item=>h('details',{className:'fl-ditem',key:item.index,'data-fleet-deliverable-row':item.index},
          h('summary',{'data-fleet-deliverable-toggle':item.index},
            h('span',{className:'fl-ttl'},h('strong',null,item.label)),
            h('span',{className:'fl-cell',title:item.category&&categoryNames[item.category]?L(...categoryNames[item.category]):L('未分类','Uncategorized')},item.category&&shortCategoryNames[item.category]?L(...shortCategoryNames[item.category]):L('未分类','Uncategorized')),
            h('span',{className:'fl-cell fl-num'},list(item.criteria).length?`${L('标准','Crit')}\u2009${list(item.criteria).length}`:'—'),
            h('span',{className:'fl-cell fl-num'},list(item.files).length?`${L('文件','Files')}\u2009${list(item.files).length}`:'—'),
            h('span',{className:'fl-cell'},badge(L(...(deliverableStatusNames[item.reviewStatus]||[item.reviewStatus,item.reviewStatus])),deliverableStatusTones[item.reviewStatus]||'neutral')),
            h('span',{className:'fl-cell'},item.latest?badge(`v${item.latest.version}`):h('span',{className:'fl-small fl-muted'},L('未提交','None')))),
          h('div',{className:'fl-dbody'},
            item.whenNodeRuns&&kv(L('对应步骤','Required when step runs'),item.whenNodeRuns),
             deliverableHumanLayer(item,L,o),
            item.latest?h(React.Fragment,null,
              h('p',{className:'fl-small fl-muted'},`${L('哈希','Hash')} ${shortHash(item.latest.sha256)} · ${L('提交','Submitted')} ${timestamp(item.latest.submittedAt,L)}`),
              h('div',{className:'fl-spaced fl-row'},
                fileLink(o,snapshotTarget(o,item.latest.snapshotPath),L('查看位置 ↗','Open location ↗'),{'data-fleet-deliverable-link':item.index}),
                !snapshotTarget(o,item.latest.snapshotPath)&&h('span',{className:'fl-mono fl-small'},item.latest.snapshotPath),
                button(L('详情','Details'),()=>openDialog({kind:'deliverable',ticketId:ticket.id,index:item.index}),{'data-fleet-deliverable':item.index,className:'fl-btn'})))
              :h('p',{className:'fl-help'},L('尚未提交产物','No artifact submitted yet')),
            item.delivery&&h('p',{className:'fl-small fl-row'},`${L('已交付','Delivered')} ${timestamp(item.delivery.deliveredAt,L)}`,fileLink(o,item.delivery.location,item.delivery.location,{className:'fl-btn fl-btn-ghost fl-mono'}))))))
          :null,
        gap.staleGates.length>0&&h('div',{className:'fl-spaced'},staleAlert(L)),
        settlementBlocked&&h('div',{className:'fl-notice fl-spaced',role:'status','data-fleet-delivery-blocked':ticket.id},
          h('p',null,L('交付被阻止','Delivery is blocked')),
          h('ul',null,...gap.unbound.map(item=>h('li',{key:`u${item.index}`},`${L('缺绑定','Unbound')}：${item.label}`)),...gap.staleGates.map(id=>h('li',{key:id},`${L('结论过期','Stale review')}：${id}`)),gap.pendingExport&&h('li',{key:'pending'},L('交付尚未导出','Delivery not exported yet'))),
          gap.canOverride&&h('div',{className:'fl-spaced'},button(L('人工交付覆盖','Human delivery override'),()=>openDialog({kind:'deliver-override',ticketId:ticket.id}),{className:'fl-btn fl-btn-danger','data-fleet-deliver-override':ticket.id,disabled:busy}))),
        delivery?.override&&h('div',{className:'fl-notice fl-spaced','data-fleet-delivery-override':ticket.id},
          h('p',null,L('已记录人工交付覆盖','Human delivery override recorded')),
          h('p',{className:'fl-small fl-muted'},`${timestamp(delivery.override.time,L)} · ${delivery.override.actor?.userId||delivery.override.actor?.kind||''}`),
          h('p',null,delivery.override.reason),
          details(L('版本缺口','Version gaps'),delivery.override.gaps)),
        latestDelivery&&h('div',{className:'fl-spaced','data-fleet-delivery-record':ticket.id},
          h('p',{className:'fl-small'},`${L('最近交付','Latest delivery')} ${timestamp(latestDelivery.time,L)} → ${latestDelivery.target||L('Ticket 交付区','Ticket delivery area')}`),
          h('div',{className:'fl-row'},fileLink(o,latestDelivery.manifestPath,`${L('清单','Manifest')} ↗`,{className:'fl-btn fl-btn-ghost fl-mono'}),fileLink(o,latestDelivery.receiptPath,`${L('回执','Receipt')} ↗`,{className:'fl-btn fl-btn-ghost fl-mono'})))),
        draft&&h('p',{className:'fl-help'},L('下方为此 Ticket 的计划。启动时冻结配置，随后派发智能体。','This Ticket’s plan is previewed below. Starting freezes its configuration before dispatch.'))),
      h('div',{className:'fl-workbench'},h('div',{className:'fl-stack'},h('section',{className:'fl-card'},h('div',{className:'fl-card-head'},h('h2',null,L('任务流程','Task flow')),row(ticket.execution&&badge(ticket.snapshot?`${L('启动快照','Snapshot')} v${ticket.snapshot.configRevision}`:L('冻结配置','Frozen configuration')),badge(`${nodes.length} ${L('节点','nodes')}`))),flow(nodes,gates,flowOptions,true,ticket.snapshot?.agents||ticket.plan?.agents||{}),...routeResults(ticket,o),
        )),
        selectedGate?gateCard(selectedGate):draft&&!ui.nodeId?h('section',{className:'fl-card fl-card-pad'},h('h2',null,L('执行准备','Ready to execute')),h('p',{className:'fl-muted fl-spaced'},L('先核对任务、角色映射和验收标准。执行对话会在任务启动后建立。','Review the goal, role mapping and acceptance criteria. Execution Sessions are created after starting.')),
          ...nodes.map(node=>kv(`${node.id}${node.role?` · ${node.role}`:''}`,node.agentId||L('未分配','Unassigned')))):nodeThread(ticket,node,o)),
      exhaustedEvents.length>0&&h('div',{className:'fl-notice fl-spaced',role:'status','data-fleet-rework-exhausted':ticket.id},
        h('p',null,L('返工预算耗尽，已升级人工决定','Rework budget exhausted; escalated to a human decision')),
        h('ul',null,...exhaustedEvents.map(a=>h('li',{key:a.id},`${a.detail?.gateId??''} · ${a.detail?.autoReworkRounds??0}/${a.detail?.maxRounds??0} · ${timestamp(a.time,L)}`)))),
      h('section',{className:'fl-card fl-card-pad fl-rawdata','data-fleet-rawdata':ticket.id},
        h('div',{className:'fl-row fl-between'},h('h2',null,L('原始数据','Raw data')),h('span',{className:'fl-small fl-muted'},L('输入、标准、配置、证据与事件明细，默认折叠，需要时展开','Inputs, criteria, configuration, evidence and event detail — collapsed until expanded'))),
        h('div',{className:'fl-spaced'},details(L('任务输入与交付物','Inputs and deliverables'),{inputs:ticket.inputs,deliverables:deliverables.map(d=>d.label),...(ticket.requirements!==undefined?{requirements:ticket.requirements}:{})})),
        selectedGate&&!draft&&details(L('审核记录','Review history'),{reviews:selectedGate.reviews,humanOverride:selectedGate.humanOverride,history:selectedGate.history,requireEvidence:selectedGate.requireEvidence??false,rework:selectedGate.rework??null}),
        !selectedGate&&node&&nodeConfigDetails(ticket,node,o),
        !selectedGate&&node&&completionEvidenceDetails(ticket,node,o),
        list(ticket.criteria).length>0&&h('div',{className:'fl-spaced','data-fleet-ticket-criteria':ticket.id},
          h('details',null,h('summary',null,`${L('整单验收标准','Ticket-wide acceptance criteria')} · ${list(ticket.criteria).length}`),
            h('p',{className:'fl-help'},L('跨交付物的治理与总体要求；每项交付物自己的标准见交付物区。','Cross-deliverable governance and overall requirements; each deliverable’s own criteria are listed with it.')),
            h('ol',{className:'fl-critlist'},...list(ticket.criteria).map((c,i)=>h('li',{key:i},text(c)))))),
        h('div',{className:'fl-spaced'},details(L('任务事件与修订','Ticket events and revisions'),{events:ticket.events,changes:ticket.changes}))));
  }
  function agentsView(o) {
    const {L,data,navigate,ui,openDialog}=o, agents=list(data.catalog?.agents);
    if(ui.page==='agent') {
      const agent=agents.find(a=>a.id===ui.agentId);
      if(!agent)return empty(L('请选择共享智能体','Choose a Root Agent'),button(L('← 智能体','← Agents'),()=>navigate('agents')));
      const attempts=list(data.tickets).flatMap(ticket=>Object.entries(ticket.execution?.nodes||{}).flatMap(([nodeId,state])=>list(state.attempts).flatMap(attempt=>{
        const config=ticket.execution?.configurations?.[attempt.configRevision],node=config?.plan?.nodes?.find(item=>item.id===nodeId);
        const sourced=list(config?.sourceRefs).some(ref=>ref.templateId===agent.id&&(ref.kind==='agent'&&ref.localId===node?.agentId));
        return sourced&&node?[{ticket,node,attempt}]:[];
      })));
      return h('div',{className:'fl-stack'},h('div',{className:'fl-row fl-between'},button(L('← 智能体','← Agents'),()=>navigate('agents'),{className:'fl-btn fl-btn-ghost'}),button(L('编辑共享定义','Edit shared definition'),()=>openDialog({kind:'root-agent',agent}))),
        h('div',{className:'fl-columns'},h('section',{className:'fl-card fl-card-pad'},row(h('span',{className:'fl-avatar','aria-hidden':true},String(agent.name||agent.id).slice(0,1).toUpperCase()),h('div',null,h('h2',null,agent.name||agent.id),h('p',{className:'fl-mono fl-small fl-muted'},agent.id)),badge(`v${agent.revision}`)),h('p',{className:'fl-help fl-spaced'},L('Root 模板；选用后按值复制到 Ticket，来源仅用于追溯。','Root template; content is copied into a Ticket and its source is retained for traceability.')),h('pre',{className:'fl-spaced'},agent.profile?.instructions||L('未配置角色指令','No role instructions')),h('div',{className:'fl-spaced'},details(L('配置与历史版本','Profile and revision history'),{profile:agent.profile,history:agent.history}))),
          h('aside',{className:'fl-card fl-card-pad'},h('h2',null,L('定义摘要','Definition')),kv('ID',agent.id),kv(L('名称','Name'),agent.name||agent.id),kv(L('版本','Revision'),agent.revision),kv(L('创建时间','Created'),timestamp(agent.createdAt,L)),kv(L('更新时间','Updated'),timestamp(agent.updatedAt,L)),kv(L('DSH 预设','DSH preset'),agent.profile?.agentPreset||L('继承默认','Host default')),kv(L('模型 / Effort','Model / effort'),agent.profile?.modelSelection?`${agent.profile.modelSelection.provider}/${agent.profile.modelSelection.model}${agent.profile.modelSelection.reasoningEffort?` · ${agent.profile.modelSelection.reasoningEffort}`:''}`:L('继承宿主默认','Inherits host default')),kv(L('复制来源','Copied from'),templateSourceText(agent.source,L)))),
        h('section',{className:'fl-card fl-card-pad'},h('h2',null,L('当前工作区执行记录','Executions in this workspace')),attempts.length?attempts.map(({ticket,node,attempt})=>h('div',{className:'fl-session fl-row fl-between',key:attempt.id},h('div',null,h('h3',null,`${ticket.goal} / ${node.id}`),status(attempt.status,L)),attempt.sessionId&&button(L('打开对话','Open conversation'),()=>o.openChat(attempt.sessionId),{'data-fleet-agent-session':attempt.sessionId}))):empty(L('此工作区暂无该智能体的执行记录','No executions for this Agent in this workspace'))));
    }
    const agentUsage=id=>list(data.tickets).filter(ticket=>Object.values(ticket.execution?.configurations??{}).some(cfg=>list(cfg?.sourceRefs).some(ref=>ref?.kind==='agent'&&ref.templateId===id))).length;
    return h('div',{className:'fl-stack'},h('div',{className:'fl-row fl-between'},h('p',{className:'fl-help'},L('Root 智能体模板按值复制进任务；这里是全部共享定义。','Root Agent templates are copied by value into Tickets. All shared definitions live here.')),button(L('新建','New'),()=>openDialog({kind:'template-new',templateKind:'agent'}),{className:'fl-btn fl-btn-primary','data-fleet-template-new':'agent'})),
      agents.length?h('div',{className:'fl-glist','data-fleet-agent-list':''},
        h('div',{className:'fl-ghead'},h('span',null,L('智能体','Agents')),h('span',{className:'fl-count'},agents.length),h('span',{className:'fl-count'},L('引用任务数 · 版本','Tickets using · Revision'))),
        ...agents.map(agent=>h('article',{className:'fl-grow fl-lrow',key:agent.id,'data-fleet-agent':agent.id},
          h('span',{className:'fl-ttl'},h('span',{className:'fl-avatar','aria-hidden':true},String(agent.name||agent.id).slice(0,1).toUpperCase()),h('span',{className:'fl-lname'},h('strong',null,agent.name||agent.id),h('small',{className:'fl-mono'},agent.id))),
          h('span',{className:'fl-cell'},agent.profile?.agentPreset||L('继承默认','Host default')),
          h('span',{className:'fl-cell fl-mono'},agent.profile?.modelSelection?`${agent.profile.modelSelection.provider}/${agent.profile.modelSelection.model}`:L('继承宿主','Host')),
          h('span',{className:'fl-cell'},String(agentUsage(agent.id))),
          h('span',{className:'fl-cell'},badge(`v${agent.revision}`)),
          h('span',{className:'fl-cell fl-lact'},button(L('查看定义 ↗','View definition ↗'),()=>navigate('agent',{agentId:agent.id}))))))
        :empty(L('暂无共享智能体，请先在原生对话中准备角色和任务。','No Root Agents. Prepare roles and a task in native Chat first.'),button(o.t('newSession'),()=>o.openChat())));
  }
  function orchestrationsView(o) {
    const {L,data,ui,navigate,openDialog}=o, flows=list(data.catalog?.orchestrations);
    if(ui.page==='orchestration') {
      const selected=flows.find(f=>f.id===ui.flowId);if(!selected)return empty(L('请选择共享编排','Choose an orchestration'));
      const scheduleUnavailable=scheduleUnavailableReason(data,L);
      const executions=list(data.tickets).flatMap(ticket=>Object.entries(ticket.execution?.configurations||{}).filter(([,config])=>list(config.sourceRefs).some(ref=>ref.kind==='orchestration'&&ref.templateId===selected.id)).map(([configRevision,config])=>({ticket,configRevision,config})));
      return h('div',{className:'fl-stack'},h('div',{className:'fl-row fl-between'},button('← '+L('编排','Orchestrations'),()=>navigate('orchestrations'),{className:'fl-btn fl-btn-ghost'}),row(
        button(L('从模板新建 Ticket','New Ticket from template'),()=>openDialog({kind:'instantiate',flowId:selected.id}),{className:'fl-btn fl-btn-primary','data-fleet-template-instantiate':selected.id}),
        button(L('安排执行','Schedule'),()=>openDialog({kind:'schedule',flowId:selected.id}),{disabled:!!scheduleUnavailable,'data-fleet-template-schedule':selected.id,title:scheduleUnavailable||L('到点按冻结配置自动建票','Create Tickets automatically at the scheduled time')}),
        button(L('编辑共享定义','Edit shared definition'),()=>openDialog({kind:'root-flow',flow:selected})))),
        scheduleUnavailable&&h('p',{className:'fl-help',role:'status','data-fleet-schedule-unavailable':''},scheduleUnavailable),
        h('section',{className:'fl-card'},h('div',{className:'fl-card-head'},row(h('h2',null,selected.id),badge(`v${selected.revision}`)),badge(L('全局共享','Root'))),flow(list(selected.definition?.nodes),list(selected.definition?.gates),o,false),h('div',{className:'fl-card-pad'},details(L('依赖与审核关卡','Dependencies and review gates'),selected.definition))),
        list(selected.definition?.nodes).length?h('section',{className:'fl-card fl-card-pad'},h('h2',null,L('节点定义','Node definitions')),h('div',{className:'fl-glist fl-spaced'},
          h('div',{className:'fl-ghead'},h('span',null,L('节点','Node')),h('span',{className:'fl-count'},L('默认执行者 · 依赖 · 类型','Default agent · dependencies · type'))),
          ...list(selected.definition?.nodes).map(node=>{const gateBefore=list(selected.definition?.gates).some(g=>list(g.from).includes(node.id));return h('div',{key:node.id,className:'fl-grow fl-lrow fl-drow'},
            h('span',{className:'fl-ttl'},h('strong',{className:'fl-mono'},node.id),node.role?h('small',null,node.role):null),
            h('span',{className:'fl-cell'},node.agentId||L('未分配','Unassigned')),
            h('span',{className:'fl-cell fl-mono'},list(node.dependsOn).join(', ')||'—'),
            h('span',{className:'fl-cell'},gateBefore?badge(L('关卡前','Before gate'),'waiting'):badge(L('执行节点','Agent node'),'neutral')));}))):null,
        h('section',{className:'fl-card fl-card-pad'},kv(L('名称','Name'),selected.name||selected.id),kv(L('复制来源','Copied from'),templateSourceText(selected.source,L)),kv(L('逻辑路由','Logic gates'),list(selected.definition?.logicGates).length?`${list(selected.definition.logicGates).length} ${L('条','gates')}`:L('无','None')),kv(L('默认值','Defaults'),selected.definition?.defaults?L('有（实例化时预填）','Present (prefill at instantiation)'):L('无','None')),kv(L('创建时间','Created'),timestamp(selected.createdAt,L)),kv(L('更新时间','Updated'),timestamp(selected.updatedAt,L)),details(L('历史修订','Revision history'),selected.history)),
        h('section',{className:'fl-card'},h('div',{className:'fl-card-head'},h('h2',null,L('关联执行记录','Linked execution records')),badge(executions.length)),executions.length?h('div',{className:'fl-card-pad'},...executions.map(({ticket,configRevision})=>ticketLink(ticket,o,{label:`${ticket.id} · v${configRevision}`,key:`${ticket.id}:${configRevision}`,className:'fl-btn'}))):empty(L('暂无使用此模板的执行记录','No execution records reference this template'))));
    }
    const flowUsage=id=>list(data.tickets).filter(ticket=>Object.values(ticket.execution?.configurations??{}).some(cfg=>list(cfg?.sourceRefs).some(ref=>ref?.kind==='orchestration'&&ref.templateId===id))).length;
    return h('div',{className:'fl-stack'},h('div',{className:'fl-row fl-between'},h('p',{className:'fl-help'},L('共享编排定义节点与审核关卡；应用时按值复制进任务。','Shared orchestrations define nodes and review gates, copied by value into Tickets.')),button(L('新建','New'),()=>openDialog({kind:'template-new',templateKind:'orchestration'}),{className:'fl-btn fl-btn-primary','data-fleet-template-new':'orchestration'})),
      flows.length?h('div',{className:'fl-glist','data-fleet-flow-list':''},
        h('div',{className:'fl-ghead'},h('span',null,L('编排','Orchestrations')),h('span',{className:'fl-count'},flows.length),h('span',{className:'fl-count'},L('引用任务数 · 版本','Tickets using · Revision'))),
        ...flows.map(item=>{
          const flowNodes=list(item.definition?.nodes),flowGates=list(item.definition?.gates);
          return h('article',{className:'fl-grow fl-lrow',key:item.id,'data-fleet-flow':item.id},
            h('span',{className:'fl-ttl'},h('span',{className:'fl-avatar','aria-hidden':true},'◇'),h('span',{className:'fl-lname'},h('strong',null,item.name||item.id),h('small',{className:'fl-mono'},item.id))),
            h('span',{className:'fl-cell'},`${flowNodes.length} ${L('节点','nodes')} · ${flowGates.length} ${L('关卡','gates')}`),
            h('span',{className:'fl-cell fl-mono'},flowNodes.map(n=>n.role||n.id).join(' → ')||'—'),
            h('span',{className:'fl-cell'},String(flowUsage(item.id))),
            h('span',{className:'fl-cell'},badge(`v${item.revision}`)),
            h('span',{className:'fl-cell fl-lact'},button(L('查看编排 ↗','View flow ↗'),()=>navigate('orchestration',{flowId:item.id}))));}))
        :empty(L('暂无共享编排，请先在原生对话中准备流程。','No orchestration definitions. Prepare a flow in native Chat.')));
  }
  function bindingView(o) {
    const {L,data,workspace,ui}=o,tickets=list(data.tickets),selected=tickets.find(ticket=>ticket.id===ui.ticketId),shown=selected?[selected]:tickets;
    return h('div',{className:'fl-stack'},h('section',{className:'fl-card fl-card-pad'},h('h2',null,L('工作区绑定','Workspace binding')),kv(L('工作区','Workspace'),workspace.title||workspace.workspaceId),kv(L('目录','Directory'),workspace.path),
      h('p',{className:'fl-help fl-spaced'},L('按 Ticket 展示计划来源、节点分配和本地资源。每个任务持有自己的配置。','Plan sources, node assignments and local resources are shown per Ticket. Each Ticket owns its configuration.'))),
      ...shown.map(ticket=>h('section',{className:'fl-card fl-card-pad',key:ticket.id,'data-fleet-ticket-binding':ticket.id},h('h2',null,ticket.goal||ticket.id),kv('Ticket ID',ticket.id),
        h('h3',{className:'fl-spaced'},L('共享编排','Shared orchestration')),h('details',null,h('summary',null,L('模板来源','Template sources')),readValue(list(ticket.activity).filter(activity=>activity.type==='template-applied').map(activity=>activity.detail))),
        h('h3',{className:'fl-spaced'},L('角色映射','Role mapping')),...list(ticket.plan?.nodes).map(node=>kv(`${node.id}${node.role?` · ${node.role}`:''}`,node.agentId||L('未分配','Unassigned'))),
        details(L('本地资源','Local resources'),ticket.plan?.inputs||{}))),
      !shown.length&&empty(L('尚无 Ticket；创建任务后会显示角色映射与本地资源。','No Tickets yet. Role mapping and local resources appear after creating a Ticket.')));
  }
  // P-46 deliverable detail: version history, hashes, source execution, reviews and delivery location.
  function deliverableDetail(o,d){
    const {L,data}=o;
    const ticket=list(data.tickets).find(t=>t.id===d.ticketId);
    const item=list(ticket?.deliverables).find(r=>r.index===d.index);
    if(!ticket||!item)return h('p',null,L('交付物不存在或已被移除。','This deliverable is no longer available.'));
    const artifact=item.artifactId?ticket.artifacts?.[item.artifactId]:null;
    const sourceNode=artifact?list(ticket.nodes).find(n=>n.id===artifact.nodeId):null;
    const sessionFor=attemptId=>list(sourceNode?.attempts).find(a=>a.id===attemptId)?.sessionId;
    const locationTarget=item.delivery?.location||snapshotTarget(o,item.latest?.snapshotPath);
    const reviews=artifact?list(ticket.gates).filter(g=>list(g.from).includes(artifact.nodeId)).flatMap(g=>[g,...list(g.history)].flatMap(cycle=>list(cycle.reviews).filter(r=>list(r.artifactRefs).some(ref=>ref.artifactId===item.artifactId)).map(r=>({gateId:g.id,cycle:cycle.cycle,review:r})))):[];
    const deliveries=list(ticket.delivery?.history).filter(row=>list(row.items).some(it=>it.deliverableIndex===d.index));
    return h('div',{className:'fl-stack'},
      kv(L('交付物','Deliverable'),item.label),
      item.description&&kv(L('内容描述','Description'),item.description),
      list(item.criteria).length>0&&kv(L('验收标准','Acceptance criteria'),h('ol',{className:'fl-critlist'},...list(item.criteria).map((c,i)=>h('li',{key:i},c)))),
      item.title&&item.spec&&h('details',null,h('summary',null,L('Agent 完整规格','Full agent spec')),h('pre',{className:'fl-mono fl-small'},item.spec)),
      kv(L('审核状态','Review status'),badge(L(...(deliverableStatusNames[item.reviewStatus]||[item.reviewStatus,item.reviewStatus])),deliverableStatusTones[item.reviewStatus]||'neutral')),
      artifact&&kv(L('来源节点','Source node'),artifact.nodeId),
      artifact&&kv(L('源文件','Source file'),h('span',{className:'fl-mono'},artifact.sourcePath)),
      kv(L('最新位置','Latest location'),locationTarget?fileLink(o,locationTarget,locationTarget,{className:'fl-btn fl-btn-ghost fl-mono','data-fleet-deliverable-location':d.index}):item.latest?h('span',{className:'fl-mono'},item.latest.snapshotPath):L('尚未提交产物','No artifact submitted yet')),
      artifact&&h('section',null,h('h3',null,L('版本历史','Version history')),h('div',{className:'fl-stack fl-spaced'},...list(artifact.versions).slice().reverse().map(v=>h('article',{className:'fl-notice',key:v.version},
        h('div',{className:'fl-row fl-between'},h('strong',null,`v${v.version}`),h('span',{className:'fl-small fl-muted'},timestamp(v.submittedAt,L))),
        h('p',{className:'fl-small fl-muted fl-mono'},`SHA-256 ${v.sha256}`),
        h('p',{className:'fl-small fl-muted'},`${v.size} B${v.mediaType?` · ${v.mediaType}`:''}`),
        h('div',{className:'fl-row'},fileLink(o,snapshotTarget(o,v.snapshotPath),L('打开此版本 ↗','Open this version ↗'),{className:'fl-btn fl-btn-ghost'}),
          sessionFor(v.attemptId)&&button(L('打开来源对话 ↗','Open source conversation ↗'),()=>o.openChat(sessionFor(v.attemptId)),{className:'fl-btn','data-fleet-artifact-session':sessionFor(v.attemptId)})))))),
      reviews.length>0&&h('section',null,h('h3',null,L('审核记录','Review records')),h('div',{className:'fl-stack fl-spaced'},...reviews.map(({gateId,cycle,review})=>h('article',{className:'fl-notice',key:review.id},
        h('div',{className:'fl-row fl-between'},h('strong',null,`${gateId} · ${L('轮次','cycle')} ${cycle}`),status(review.decision,L)),
        h('p',{className:'fl-small fl-muted'},`${timestamp(review.time,L)} · ${review.actor?.kind==='human'?L('人工','human'):L('智能体','agent')} · ${list(review.artifactRefs).filter(r=>r.artifactId===item.artifactId).map(r=>`v${r.version}`).join(', ')}${review.bindingKind==='auto-latest'?` (${L('自动绑定','auto-bound')})`:''}`),
        h('p',{className:'fl-small'},text(review.evidence)))))),
      deliveries.length>0&&h('section',null,h('h3',null,L('交付记录','Delivery records')),h('div',{className:'fl-stack fl-spaced'},...deliveries.map(row=>h('article',{className:'fl-notice',key:row.id},
        h('p',{className:'fl-small'},`${timestamp(row.time,L)} → ${row.target||L('Ticket 交付区','Ticket delivery area')}`),
        h('div',{className:'fl-row'},fileLink(o,row.manifestPath,`${L('清单','Manifest')} ↗`,{className:'fl-btn fl-btn-ghost fl-mono'}),fileLink(o,row.receiptPath,`${L('回执','Receipt')} ↗`,{className:'fl-btn fl-btn-ghost fl-mono'})))))),
      !artifact&&h('p',{className:'fl-help'},L('尚未提交绑定产物；不创建占位文件。','No bound artifact submitted yet; no placeholder file is created.')));
  }
  // Inline model seat (DSH composer style): one compact trigger in the node meta line; the menu drills
  // into model or effort panes and saves on selection.
  function ModelSeat({o,ticket,node,gate}) {
    const {L,busy,act,data,ui}=o;
    const catalog=data.catalog?.modelCatalog, agents=ticket.plan.agents;
    const override=gate?gate.modelSelection:node.modelSelection;
    const eff=modelDisplay(o,gate?.modelSelection?{...node,modelSelection:gate.modelSelection}:node,agents,L);
    const providers=list(catalog?.groups);
    const model=list(providers.find(g=>g.id===eff.provider)?.models).find(m=>m.id===eff.modelId);
    const efforts=list(model?.reasoning?.efforts);
    const chosenEffort=(override||node.modelSelection||agents?.[node.agentId]?.profile?.modelSelection)?.reasoningEffort||'';
    const effortName=id=>efforts.find(e=>e.id===id)?.name||id;
    const inherited=override?modelDisplay(o,gate?node:{...node,modelSelection:undefined},agents,L):null;
    const missing=Boolean(eff.modelId&&providers.length&&!model);
    const label=gate?L('审核模型','Review model'):L('执行模型','Execution model');
    const id=React.useId().replace(/[^\w-]/g,''),menuId=`fl-seat-${id}`,anchor=`--fl-seat-${id}`;
    const trigger=React.useRef(null),menu=React.useRef(null);
    const [pane,setPane]=React.useState('root');
    const [search,setSearch]=React.useState('');
    const [highlight,setHighlight]=React.useState(0);
    const [saving,setSaving]=React.useState(false);
    const [failed,setFailed]=React.useState(false);
    const modelCount=providers.reduce((n,g)=>n+list(g.models).length,0);
    const query=search.trim().toLocaleLowerCase();
    const fuzzy=label=>{let at=0;return Array.from(query).every(ch=>{const i=label.toLocaleLowerCase().indexOf(ch,at);at=i+1;return i>=0;});};
    const modelGroups=providers.map(g=>({id:g.id,name:g.name||g.id,items:list(g.models).filter(m=>fuzzy(m.name||m.id))})).filter(g=>g.items.length);
    const flat=modelGroups.flatMap(g=>g.items.map(m=>({g,m})));
    const [modelChange,setModelChange]=React.useState(null);
    async function apply(selection,options,base=ticket) {
      if(saving)return;
      const choices=ticketSeries(base,data).filter(needsSaveScope);
      if(!options&&base.status!=='running'&&choices.length){setModelChange({selection,base,choices});return;}
      setSaving(true);setFailed(false);
      const scope={ticketId:base.id,expectedRevision:base.revision};
      const result=ticket.status==='running'
        ?await act('node-model',{...scope,nodeId:node.id,modelSelection:validSelection(selection)})
        :await act('draft-save',{...scope,sessionId:base.originSessionId,...options,plan:gate?applyGateModelSelection(base.plan,gate.id,selection):applyNodeModelSelection(base.plan,node.id,selection)});
      setSaving(false);
      if(result){menu.current?.hidePopover?.();trigger.current?.focus();}
      else setFailed(true);
    }
    const close=()=>{menu.current?.hidePopover?.();trigger.current?.focus();};
    const pickModel=(g,m)=>{if(g.id===eff.provider&&m.id===eff.modelId)return close();void apply({provider:g.id,model:m.id});};
    const pickEffort=value=>{if(value===chosenEffort&&override)return close();void apply({provider:eff.provider,model:eff.modelId,...(value?{reasoningEffort:value}:{})});};
    React.useEffect(()=>{
      const el=menu.current;if(!el?.matches?.(':popover-open'))return;
      const input=el.querySelector('input');
      const target=pane==='model'&&input&&globalThis.matchMedia?.('(pointer: fine)').matches?input:el.querySelector('[aria-checked="true"]')||el.querySelector('[role="menuitem"]:not(.fl-seat-back),[role="menuitemradio"]');
      target?.focus();
    },[pane]);
    function keys(event) {
      if(event.nativeEvent.isComposing)return;
      const el=event.currentTarget,inSearch=event.target.tagName==='INPUT';
      if(pane!=='root'&&(event.key==='Escape'||event.key==='Tab'&&event.shiftKey||event.key==='ArrowLeft'&&!inSearch)){event.preventDefault();setPane('root');setSearch('');return;}
      if(pane==='root'&&event.key==='ArrowRight'&&event.target.dataset.fleetModelRow&&event.target.dataset.fleetModelRow!=='inherit'){event.preventDefault();event.target.click();return;}
      if(inSearch&&['Enter','Tab'].includes(event.key)&&flat[highlight]){event.preventDefault();pickModel(flat[highlight].g,flat[highlight].m);return;}
      if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
      if(inSearch){
        if(['Home','End'].includes(event.key)||!flat.length)return;
        event.preventDefault();
        const next=(highlight+(event.key==='ArrowDown'?1:-1)+flat.length)%flat.length;
        setHighlight(next);el.querySelectorAll('[role="menuitemradio"]')[next]?.scrollIntoView({block:'nearest'});return;
      }
      const rows=Array.from(el.querySelectorAll('[role="menuitem"]:not(:disabled),[role="menuitemradio"]:not(:disabled)'));if(!rows.length)return;
      event.preventDefault();
      const index=rows.indexOf(event.target);
      const next=event.key==='Home'?0:event.key==='End'?rows.length-1:event.key==='ArrowDown'?(index+1)%rows.length:(index<=0?rows.length-1:index-1);
      rows[next].focus();
    }
    const check=on=>h('span',{className:'fl-seat-check','aria-hidden':true},on?'✓':'');
    const caption=`${eff.text}${eff.effort?` · ${effortName(eff.effort)}`:''}`;
    const back=label=>h('button',{type:'button',key:'back',role:'menuitem',className:'fl-seat-back',onClick:()=>{setPane('root');setSearch('');}},h('span',{'aria-hidden':true},'‹'),h('span',null,label));
    let row=0;
    const body=pane==='model'?[
        back(L('模型','Model')),
        modelCount>4&&h('input',{key:'q',type:'search',className:'fl-seat-search',placeholder:L('搜索模型','Search models'),'aria-label':L('搜索模型','Search models'),value:search,onChange:e=>{setSearch(e.target.value);setHighlight(0);}}),
        ...modelGroups.map(g=>h('div',{key:g.id,role:'group','aria-label':g.name},providers.length>1&&h('div',{className:'fl-seat-heading','aria-hidden':true},g.name),...g.items.map(m=>{const on=g.id===eff.provider&&m.id===eff.modelId,mark=search&&row===highlight?'true':undefined;row++;return h('button',{type:'button',key:m.id,role:'menuitemradio','aria-checked':on,'aria-label':`${m.name||m.id} · ${g.name}`,'data-highlighted':mark,'data-fleet-model-option':m.id,disabled:saving,onClick:()=>pickModel(g,m)},h('span',{className:'fl-seat-label'},m.name||m.id),check(on));}))),
        !modelGroups.length&&h('p',{key:'none',role:'status',className:'fl-seat-heading'},providers.length?L('没有匹配的模型','No models match'):L('模型目录不可用','Model catalog unavailable'))]
      :pane==='effort'?[
        back(L('推理强度','Reasoning effort')),
        ...[{id:'',name:L('模型默认','Model default')},...efforts].map(e=>h('button',{type:'button',key:e.id||'default',role:'menuitemradio','aria-checked':e.id===chosenEffort,'data-fleet-model-option':e.id||'default',disabled:saving,onClick:()=>pickEffort(e.id)},h('span',{className:'fl-seat-label'},e.name||e.id),check(e.id===chosenEffort)))]
      :[
        h('button',{type:'button',key:'m',role:'menuitem',className:'fl-seat-row','data-fleet-model-row':'model',onClick:()=>{setPane('model');setHighlight(0);}},h('span',{className:'fl-seat-label'},L('模型','Model')),h('span',{className:'fl-seat-value'},eff.text),h('span',{className:'fl-seat-chevron','aria-hidden':true},'›')),
        efforts.length>0&&h('button',{type:'button',key:'e',role:'menuitem',className:'fl-seat-row','data-fleet-model-row':'effort',onClick:()=>setPane('effort')},h('span',{className:'fl-seat-label'},L('推理强度','Reasoning effort')),h('span',{className:'fl-seat-value'},chosenEffort?effortName(chosenEffort):L('模型默认','Model default')),h('span',{className:'fl-seat-chevron','aria-hidden':true},'›')),
        inherited&&h('div',{key:'sep',className:'fl-seat-sep',role:'separator'}),
        inherited&&h('button',{type:'button',key:'r',role:'menuitem',className:'fl-seat-row','data-fleet-model-row':'inherit',disabled:saving,onClick:()=>void apply(null)},h('span',{className:'fl-seat-label'},L('恢复继承','Restore inheritance')),h('span',{className:'fl-seat-value'},inherited.text))];
    return h('span',{className:'fl-seat','data-fleet-ticket-model':gate?undefined:node.id,'data-fleet-ticket-gate-model':gate?.id},
      h('button',{type:'button',ref:trigger,className:'fl-seat-trigger',popoverTarget:menuId,disabled:busy&&!saving,'aria-haspopup':'menu','aria-label':`${label} · ${caption}`,title:`${eff.provider?`${eff.provider} / `:''}${caption}`,style:{anchorName:anchor},'data-fleet-model-menu-trigger':'seat'},
        h('span',{className:'fl-seat-label'},caption),missing&&h('span',{className:'fl-seat-missing'},L('不在目录','Not in catalog')),h('span',{className:saving?'fl-seat-chevron fl-seat-saving':'fl-seat-chevron','aria-hidden':true},saving?'◌':h('svg',{width:10,height:10,viewBox:'0 0 10 10'},h('path',{d:'M2.5 3.75 5 6.25l2.5-2.5',fill:'none',stroke:'currentColor',strokeWidth:1.4,strokeLinecap:'round',strokeLinejoin:'round'})))),
      h('div',{id:menuId,ref:menu,popover:'auto',role:'menu','aria-label':label,className:'fl-seat-menu',style:{positionAnchor:anchor},onKeyDown:keys,onToggle:event=>{
        if(event.newState==='open'){setPane('root');setFailed(false);const el=event.currentTarget;requestAnimationFrame(()=>el.querySelector('[role="menuitem"]')?.focus());}
        else {setPane('root');setSearch('');setHighlight(0);setModelChange(null);}
      }},...(modelChange?[h(ScopePicker,{key:'scope',choices:modelChange.choices,L,busy:saving,onChoose:options=>{const held=modelChange;setModelChange(null);if(options)void apply(held.selection,options,held.base);}})]:body.filter(Boolean)),
        failed&&h('p',{className:'fl-seat-error',role:'alert'},typeof ui?.error==='string'&&ui.error?ui.error:L('保存失败，请重试。','Save failed. Try again.'))));
  }
  function dialog(o) {
    const {ui,L,busy,setUI,act,data}=o, d=ui.dialog;
    if(!d)return null;
    const close=()=>setUI({dialog:null,dialogError:null});
    const field=(label,name,value='',props={})=>h('label',{className:'fl-field',key:name},label,h(props.multiline?'textarea':'input',{name,defaultValue:value,...props,multiline:undefined}));
    const title=d.kind==='review'?(d.decision==='passed'?L('审核通过','Pass review'):L('退回审核','Return review')):({revise:L('修改任务草稿','Edit draft'),start:L('确认执行计划','Confirm execution plan'),retry:L('重试节点','Retry node'),change:L('修改当前节点任务','Change this node task'),pass:L('人工通过审核','Pass review as human'),'deliver-override':L('人工交付覆盖','Human delivery override'),abandon:L('放弃执行此 Ticket','Abandon this Ticket'),deliverable:L('交付物详情','Deliverable details'),preview:L('旧草稿预览','Legacy draft preview'),'root-agent':L('编辑共享智能体','Edit Root Agent'),'root-flow':L('编辑共享编排','Edit Root orchestration'),schedule:L('安排执行','Schedule runs'),instantiate:L('从模板新建 Ticket','New Ticket from template'),'series-config':L('编辑系列配置','Edit series configuration'),'series-delete':L('删除计划','Delete schedule'),'template-new':L('新建 Root 模板','New Root template'),'template-from-ticket':L('保存为编排模板','Save as orchestration template'),'template-from-node':L('保存为 Agent 模板','Save as Agent template')})[d.kind];
    const ticket=list(data.tickets).find(t=>t.id===d.ticketId);
    if(d.kind==='draft-delete'){
      const changed=!canDeleteDraft(ticket)||ticket.revision!==d.expectedRevision;
      const confirm=async event=>{
        event.preventDefault();
        if(!busy&&!changed)await act('draft-delete',{ticketId:d.ticketId,expectedRevision:d.expectedRevision});
      };
      return h(Modal,{title:L('删除草稿','Delete draft'),onClose:close,busy,L,restoreListFocus:true},h('form',{onSubmit:confirm},h('div',{className:'fl-stack'},
        h('p',{className:'fl-pre-wrap'},L(`要永久删除草稿「${d.title}」吗？`,`Permanently delete the draft “${d.title}”?`)),
        ui.dialogError&&h('p',{role:'alert',className:'fl-notice'},ui.dialogError),
        changed&&h('p',{role:'status',className:'fl-notice'},L('此草稿已更改或已不可用。请关闭此窗口并查看任务列表。','This draft changed or is no longer available. Close this dialog and check the Tickets list.')),
        h('div',{className:'fl-dialog-actions'},button(L('取消','Cancel'),close,{disabled:busy,'data-fleet-draft-delete-cancel':''}),button(busy?L('正在删除…','Deleting…'):L('确认删除','Confirm delete'),undefined,{type:'submit',className:'fl-btn fl-btn-danger',disabled:busy||changed,'data-fleet-draft-delete-confirm':''})))));
    }
    if(d.kind!=='abandon'&&isIncompatibleDraft(ticket||d.ticket))return h(Modal,{title:L('不兼容草稿','Incompatible draft'),onClose:close,busy,L},incompatibleDraftNotice(ticket||d.ticket,o));
    if(d.kind==='revise')return h(Modal,{inPane:o.surface==='side-pane',title:['draft','stopped'].includes(ticket?.status)?title:L('任务计划','Ticket plan'),onClose:close,busy,L},renderDraftEditor({...o,draft:ticket||d.ticket,error:ui.dialogError,onSave:async(plan,base,options)=>{const body=await act('draft-save',{ticketId:base.id,expectedRevision:base.revision,sessionId:base.originSessionId,plan,...(options||{})});const result=body?.result;return result?.ticket??result;},onStart:async()=>{await act('start',{ticketId:(ticket||d.ticket).id});},onSchedule:async args=>(await act('series-create',{sourceTicketId:(ticket||d.ticket).id,...args}))?.result??null,onOpenSeries:seriesId=>{close();o.navigate('schedules',{scheduleId:seriesId});},onReload:o.refresh,onDirtyChange:o.onDraftDirtyChange}));
    if(d.kind==='schedule'){
      const unavailable=scheduleUnavailableReason(data,L);
      if(d.flowId){
        const flow=list(data.catalog?.orchestrations).find(f=>f.id===d.flowId);
        if(!flow)return h(Modal,{title,onClose:close,busy,L},empty(L('编排模板不存在','Orchestration template not found')));
        return h(Modal,{title,onClose:close,busy,L},h(TemplateTicketForm,{L,flow,catalog:data.catalog,mode:'schedule',busy,error:ui.dialogError,unavailable,onCancel:close,onSubmit:async args=>(await act('series-create',args))?.result??null}));
      }
      if(!ticket)return h(Modal,{title,onClose:close,busy,L},empty(L('任务不存在','Ticket not found')));
      return h(Modal,{title,onClose:close,busy,L},h(ScheduleForm,{L,initialName:ticketTitle(ticket),busy,error:ui.dialogError,unavailable,summary:planFreezeSummary(ticket.plan,L),onCancel:close,onSubmit:async args=>(await act('series-create',{sourceTicketId:ticket.id,...args}))?.result??null}));
    }
    if(d.kind==='instantiate'){
      const flow=list(data.catalog?.orchestrations).find(f=>f.id===d.flowId);
      if(!flow)return h(Modal,{title,onClose:close,busy,L},empty(L('编排模板不存在','Orchestration template not found')));
      return h(Modal,{title,onClose:close,busy,L},h(TemplateTicketForm,{L,flow,catalog:data.catalog,mode:'instantiate',busy,error:ui.dialogError,onCancel:close,onSubmit:async args=>(await act('template-instantiate',args))?.result??null}));
    }
    if(d.kind==='template-from-ticket'){
      if(!ticket)return h(Modal,{title,onClose:close,busy,L},empty(L('任务不存在','Ticket not found')));
      return h(Modal,{title,onClose:close,busy,L},h(SaveOrchestrationForm,{L,ticket,catalog:data.catalog,busy,error:ui.dialogError,onCancel:close,onSubmit:async args=>{await act('template-save-from-ticket',args);}}));
    }
    if(d.kind==='template-from-node'){
      if(!ticket)return h(Modal,{title,onClose:close,busy,L},empty(L('任务不存在','Ticket not found')));
      return h(Modal,{title,onClose:close,busy,L},h(SaveAgentForm,{L,ticket,nodeId:d.nodeId,catalog:data.catalog,busy,error:ui.dialogError,onCancel:close,onSubmit:async args=>{await act('template-save',args);}}));
    }
    if(d.kind==='series-config'){
      const series=list(data.series?.items).find(s=>s.id===d.seriesId);
      if(!series)return h(Modal,{title,onClose:close,busy,L},empty(L('计划不存在或已删除','Schedule not found or deleted')));
      return h(Modal,{title,onClose:close,busy,L},h(SeriesConfigForm,{L,data,series,busy,error:ui.dialogError,onCancel:close,onSubmit:async args=>{await act('series-update',args);}}));
    }
    if(d.kind==='series-delete')return h(Modal,{title,onClose:close,busy,L},h('form',{onSubmit:async event=>{event.preventDefault();await act('series-delete',{seriesId:d.seriesId});}},h('div',{className:'fl-stack'},
      h('p',null,L(`删除计划「${d.name||d.seriesId}」将停止后续建票；已有期次记录与 Ticket 保留。`,`Deleting schedule “${d.name||d.seriesId}” stops future Ticket creation; existing occurrence records and Tickets are retained.`)),
      ui.dialogError&&h('p',{role:'alert',className:'fl-notice'},ui.dialogError),
      h('div',{className:'fl-dialog-actions'},button(L('取消','Cancel'),close,{disabled:busy}),button(busy?L('正在删除…','Deleting…'):L('确认删除','Confirm delete'),undefined,{type:'submit',className:'fl-btn fl-btn-danger',disabled:busy,'data-fleet-series-delete-confirm':''})))));
    if(d.kind==='deliverable')return h(Modal,{title,onClose:close,busy,L},deliverableDetail(o,d));
    const fields=[];
    if(d.kind==='start') fields.push(h('p',{key:'goal'},ticket?.goal),h('div',{key:'preview',className:'fl-notice'},...list(ticket?.plan?.nodes).map(node=>kv(`${node.id}${node.role?` · ${node.role}`:''}`,node.agentId||L('未分配','Unassigned')))),details(L('输入、交付物与整单标准','Inputs, deliverables and ticket-wide criteria'),{inputs:ticket?.inputs,deliverables:list(ticket?.deliverables).map(r=>r.label),criteria:ticket?.criteria}),h('p',{key:'hint',className:'fl-help'},L('启动会保存当前定义快照，并开始调用智能体。','Starting stores the current definition snapshot and dispatches Agents.')));
    else if(d.kind==='retry')fields.push(field(L('重试原因','Reason'),'reason','',{required:true,multiline:true}));
    else if(d.kind==='abandon')fields.push(h('p',{key:'scope'},L('放弃只标记这一个 Ticket：默认从「需要关注」收起，历史与计划保留，可随时恢复。关联的周期计划不受影响，后续期次照常创建。','Abandoning marks only this Ticket: it collapses from Needs attention, history and plan are retained, and it can be restored anytime. Linked recurring schedules are untouched; future occurrences still run.')),field(L('放弃原因（可选）','Reason (optional)'),'reason','',{multiline:true}));
    else if(d.kind==='change')fields.push(field(L('节点任务 JSON','Node task JSON'),'task',json(d.task),{required:true,multiline:true,rows:8}),h('p',{key:'scope',className:'fl-help'},L('仅修改当前任务中的这个节点，保留原修订和执行记录。','Changes only this Ticket node and retains prior revisions and attempts.')));
    else if(d.kind==='pass')fields.push(h('p',{key:'review'},`${d.gateId} · `+L('这项决定记录为人工通过，原有和后续智能体审核意见继续保留。','This records a human override and retains previous and subsequent Agent reviews.')));
    else if(d.kind==='review'){
      const gate=list(ticket?.gates).find(g=>g.id===d.gateId);
      const bindable=reviewSourceArtifacts(ticket,gate).map(([id,a])=>{const v=list(a.versions).at(-1);return `${id} v${v?.version} · ${shortHash(v?.sha256)}`;});
      fields.push(field(d.decision==='passed'?L('审核证据','Review evidence'):L('退回原因与证据','Feedback and evidence'),'evidence','',{required:true,multiline:true}),
        h('p',{key:'bind',className:'fl-help'},bindable.length?L(`缺省自动绑定最新产物版本：${bindable.join(' · ')}。`,`Auto-binds the latest artifact versions by default: ${bindable.join(' · ')}.`):L('当前没有可绑定的产物版本。','No artifact versions are available to bind.')));
    }
    else if(d.kind==='deliver-override'){
      const rows=list(ticket?.deliverables).filter(r=>!r.artifactId&&r.reviewStatus!=='skipped'),stale=list(ticket?.gates).filter(g=>g.coverage==='stale');
      fields.push(h('p',{key:'gaps'},L('此操作显式放行交付，记录来源、理由与版本缺口；不伪造审核结论。','This explicitly releases delivery and records the source, reason and version gaps; it never fabricates a review conclusion.')),
        (rows.length>0||stale.length>0)&&h('ul',{key:'list'},...rows.map(r=>h('li',{key:`u${r.index}`},`${L('缺绑定','Unbound')}：${r.label}`)),...stale.map(g=>h('li',{key:g.id},`${L('结论过期','Stale review')}：${g.id}`))),
        field(L('覆盖理由','Override reason'),'reason','',{required:true,multiline:true}));
    }
    else if(d.kind==='root-agent')fields.push(field(L('角色指令','Instructions'),'instructions',d.agent.profile?.instructions||'',{multiline:true,rows:8}),h('label',{className:'fl-field',key:'preset'},L('DSH 预设','DSH preset'),h('input',{name:'agentPreset',defaultValue:d.agent.profile?.agentPreset||'',list:'fleet-presets'}),h('datalist',{id:'fleet-presets'},...list(data.catalog?.availablePresets).map(p=>{const id=typeof p==='string'?p:p.id;return h('option',{key:id,value:id},typeof p==='string'?p:p.name||p.label||id);}))),h('div',{key:'model',className:'fl-field'},h('span',{className:'fl-small fl-muted'},L('模型 / Effort（留空继承宿主默认）','Model / effort (empty inherits the host default)')),h(ModelFields,{catalog:data.catalog?.modelCatalog,initial:d.agent.profile?.modelSelection,L,prefix:'root-'})),h('p',{key:'scope',className:'fl-help'},L('更新全局共享定义。已启动的任务保留原快照；模型选择按值复制到选用的 Ticket。','Updates the shared Root definition. Started Tickets retain their snapshots; the model selection is copied by value into Tickets that use it.')));
    else if(d.kind==='root-flow')fields.push(field(L('编排定义 JSON','Orchestration definition JSON'),'definition',json(d.flow.definition),{required:true,multiline:true,rows:14}),h('p',{key:'scope',className:'fl-help'},L('更新全局共享编排；已启动的任务保留原计划。','Updates the shared Root orchestration; started Tickets retain their plans.')));
    else if(d.kind==='template-new')fields.push(field(L('模板 ID','Template ID'),'id','',{required:true}),field(L('名称（可选）','Name (optional)'),'name',''),field(L('模板内容 JSON','Template content JSON'),'content',d.templateKind==='agent'?json({name:'',profile:{instructions:''}}):json({nodes:[],gates:[]}),{required:true,multiline:true,rows:12}),h('p',{key:'scope',className:'fl-help'},L('新建要求 ID 未被使用；ID 已存在时会被拒绝，请改用「编辑共享定义」更新已有模板（保留历史）。','Creating requires an unused ID; a duplicate is rejected — use “Edit shared definition” to update an existing template (history is kept).')));
    async function submit(event) {
      event.preventDefault();const f=new FormData(event.currentTarget);const value=name=>String(f.get(name)||'');
      try {
        if(d.kind==='root-agent') {const profile={...d.agent.profile,instructions:value('instructions')};if(value('agentPreset').trim())profile.agentPreset=value('agentPreset').trim();else delete profile.agentPreset;const provider=value('root-provider').trim(),model=value('root-model').trim(),effort=value('root-effort').trim();if(provider&&model)profile.modelSelection={provider,model,...(effort?{reasoningEffort:effort}:{})};else delete profile.modelSelection;await act(d.kind,{agentId:d.agent.id,profile});}
        else if(d.kind==='root-flow')await act(d.kind,{orchestrationId:d.flow.id,definition:JSON.parse(value('definition'))});
        else if(d.kind==='template-new'){const name=value('name').trim();await act('template-save',{kind:d.templateKind,id:value('id').trim(),...(name?{name}:{}),content:JSON.parse(value('content'))});}
        else await act(d.kind,{ticketId:d.ticketId,...(d.nodeId?{nodeId:d.nodeId}:{}),...(d.gateId?{gateId:d.gateId}:{}),...(d.kind==='retry'||d.kind==='deliver-override'?{reason:value('reason')}:{}),...(d.kind==='abandon'?{expectedRevision:d.expectedRevision,...(value('reason').trim()?{reason:value('reason').trim()}:{})}:{}),...(d.kind==='change'?{task:JSON.parse(value('task'))}:{}),...(d.kind==='review'?{decision:d.decision==='passed'?'passed':'returned',evidence:value('evidence')}:{})});
      }catch(error){setUI({dialogError:error instanceof SyntaxError?'fleet-ui/invalid-json':error.message});}
    }
    const validate=event=>{const field=event.target;field.setCustomValidity('');if(field.validity.valueMissing)field.setCustomValidity(field.tagName==='SELECT'?L('请选择一项。','Please select an option.'):L('请填写此项。','Please fill out this field.'));};
    const clearValidation=event=>event.target.setCustomValidity?.('');
    const errorMessage=ui.dialogError==='fleet-ui/invalid-json'?L('JSON 格式有误，请检查引号、逗号和括号。','Invalid JSON. Check quotes, commas and brackets.'):ui.dialogError;
    return h(Modal,{title,onClose:close,busy,L},h('form',{onSubmit:submit,onInvalid:validate,onInput:clearValidation,onChange:clearValidation},h('div',{className:'fl-stack'},...fields),errorMessage&&h('p',{role:'alert',className:'fl-notice fl-spaced'},errorMessage),h('div',{className:'fl-dialog-actions'},button(L('取消','Cancel'),close,{disabled:busy}),button(busy?L('正在保存…','Saving…'):d.kind==='start'?L('确认并启动','Confirm and start'):d.kind==='abandon'?L('我放弃执行这个 Ticket','Abandon this Ticket'):L('确认保存','Confirm'),undefined,{type:'submit',className:d.kind==='abandon'?'fl-btn fl-btn-danger':'fl-btn fl-btn-primary',disabled:busy,'data-fleet-abandon-confirm':d.kind==='abandon'?'':undefined}))));
  }
  function renderDashboard(options) {
    // Unsupported draft shapes must not enter execution projection before the UI guard.
    const tickets=list(options.data?.tickets).map(ticket=>isIncompatibleDraft(ticket)?{...ticket,goal:ticketTitle(ticket),incompatibleGoal:typeof ticket.plan?.goal==='string'?ticket.plan.goal:typeof ticket.plan?.ticket?.goal==='string'?ticket.plan.ticket.goal:typeof ticket.goal==='string'?ticket.goal:null,nodes:[],gates:[],events:list(ticket.activity),changes:[]}:projectTicket(ticket));
    const o={...options,data:{...options.data,tickets},L:language(options)}, {L,workspace,ui,data,mode,t,enabled,busy}=o;
    const page=ui.page||'overview';
    const tabs=[['overview',L('概览','Overview')],['tickets',L('任务','Tickets')],['schedules',L('计划','Schedules')],['agents',L('智能体','Agents')],['orchestrations',L('编排','Orchestrations')],['binding',L('工作区绑定','Workspace binding')]];
    const parent=({ticket:'tickets',agent:'agents',orchestration:'orchestrations'})[page]||page;
    const titles={overview:L('工作区概览','Workspace overview'),tickets:L('任务','Tickets'),ticket:L('任务工作面','Ticket workspace'),schedules:L('计划','Schedules'),agents:L('共享智能体','Root Agents'),agent:L('智能体定义','Agent definition'),orchestrations:L('共享编排','Root orchestrations'),orchestration:L('编排定义','Orchestration definition'),binding:L('工作区绑定','Workspace binding')};
    const valid=workspace&&enabled;
    // Side-pane surface: the same shared Ticket detail, responsive via container
    // queries; workspace chrome (tabs / page header / dashboard jump) stays out.
    const sidePane=o.surface==='side-pane';
    return h('div',{className:'fl-content',lang:options.language,...(sidePane?{'data-fleet-side-pane':''}:{})},h('div',{className:'fl-crumb'},row(h('strong',null,'oh-my-dsh-fleet'),h('span',{className:'fl-muted'},'/'),h('span',{'data-fleet-workspace-title':''},workspace?.title||workspace?.path||t('preview'))),h('div',{className:'fl-row fl-crumb-actions'},languageSelect(o),sidePane?button(t('refresh'),o.refresh,{disabled:data.pending||busy,className:'fl-btn fl-btn-ghost'}):o.surface==='session-tab'?button(L('在全屏 Dashboard 打开 ↗','Open in fullscreen Dashboard ↗'),o.openWorkspaceDashboard,{className:'fl-btn fl-btn-ghost','data-fleet-open-dashboard':''}):h(React.Fragment,null,button(t('toControl'),o.toControl,{className:'fl-btn fl-btn-ghost'}),button(t('returnToConversation'),o.returnToConversation,{className:'fl-btn fl-btn-ghost'})))),
      valid&&!sidePane&&h('nav',{className:'fl-tabs','aria-label':L('Fleet 工作区','Fleet workspace')},...tabs.map(([id,label])=>button(label,()=>o.navigate(id),{key:id,className:'fl-btn fl-btn-ghost','data-fleet-tab':id,'aria-current':parent===id?'page':undefined,'aria-pressed':parent===id}))),
      !sidePane&&h('header',{className:'fl-head'},h('div',null,h('div',{className:'fl-row'},h('h1',{id:'dsh-fleet-shell-title'},valid?titles[page]:t('title')),data.pluginVersion&&badge(`v${data.pluginVersion}`)),valid&&h('p',{'data-fleet-workspace-path':''},workspace.path)),valid&&row(button(t('refresh'),o.refresh,{disabled:data.pending||busy}),button(L('新建任务','New Ticket'),()=>o.openDialog({kind:'prepare'}),{className:'fl-btn fl-btn-primary',disabled:!data.ready||busy}))),
      !valid?h('div',{className:'fl-notice',role:'status'},t(workspace?'disabledTarget':'unavailable')):h(React.Fragment,null,
        data.error&&h('div',{className:'fl-notice fl-spaced',role:'alert'},h('p',null,data.error),button(t('retry'),o.refresh,{disabled:data.pending})),
        data.ready&&data.health?.ready===false&&h('div',{className:'fl-notice fl-spaced',role:'alert'},data.health.error||L('运行服务暂未就绪','Runtime is not ready')),
        ui.error&&h('div',{className:'fl-notice fl-spaced',role:'alert'},ui.error),
        ui.notice&&h('p',{className:'fl-notice fl-spaced',role:'status'},ui.notice),
        !data.ready&&!data.error&&h('p',{className:'fl-loading',role:'status'},L('正在读取 Fleet 数据…','Loading Fleet data…')),
        data.ready&&!(sidePane&&ui.dialog?.kind==='revise')&&(page==='overview'?overview(o):page==='tickets'?ticketsView(o):page==='ticket'?ticketView(o):page==='schedules'?schedulesView(o):['agents','agent'].includes(page)?agentsView(o):['orchestrations','orchestration'].includes(page)?orchestrationsView(o):bindingView(o)),
        !data.ready&&sessions(o)),
      mode.error&&h('p',{className:'fl-notice fl-spaced',role:'alert'},mode.error),valid&&dialog(o));
  }
  function renderControl(o) {
    const {t,mode,workspaces,requestModes,selectWorkspace,returnToConversation}=o,L=language(o);
    const enabled=workspaces.filter(w=>mode.enabledWorkspaceIds.includes(w.workspaceId));
    return h('div',{className:'fl-content',lang:o.language},h('div',{className:'fl-crumb'},h('strong',null,'oh-my-dsh-fleet'),h('div',{className:'fl-row fl-crumb-actions'},languageSelect(o),button(t('returnToConversation'),returnToConversation,{className:'fl-btn fl-btn-ghost'}))),
      h('header',{className:'fl-head'},h('div',null,h('h1',{id:'fleet-control-title'},L('中控台','Control center')),h('p',null,t('controlIntro')))),
      h('div',{className:'fl-metrics'},metric(t('registered'),workspaces.length,L('由 DSH 原生登记','Registered by DSH'),{'data-fleet-registered-count':''}),metric(t('enabledCount'),mode.ready?enabled.length:'—',L('独立的工作区任务视图','Independent workspace task views'),{'data-fleet-enabled-count':''})),
      h('div',{className:'fl-toolbar'},h('h2',null,t('registered')),button(t('refresh'),()=>requestModes(),{disabled:mode.pending,'data-fleet-refresh':''})),
      mode.error&&h('div',{className:'fl-notice',role:'alert'},h('p',null,mode.error),button(t('retry'),()=>requestModes(),{disabled:mode.pending})),
      !mode.ready&&!mode.error&&h('p',{className:'fl-loading',role:'status'},t('loading')),mode.notice&&h('p',{role:'status','data-fleet-saved':''},t('saved')),
      h('div',{className:'fl-card'},...workspaces.map(workspace=>{const on=mode.enabledWorkspaceIds.includes(workspace.workspaceId);return h('article',{key:workspace.workspaceId,className:'fl-control-row','data-fleet-control-row':workspace.workspaceId},
        h('div',{className:'fl-control-info'},h('h2',{'data-fleet-control-title':''},workspace.title||workspace.path),h('p',null,workspace.path)),badge(mode.ready?t(on?'modeOn':'available'):t('loading'),on?'success':'neutral'),
        row(on&&button(t('openFleet'),()=>selectWorkspace(workspace.workspaceId),{className:'fl-btn fl-btn-primary','data-fleet-open':workspace.workspaceId}),button(t(mode.pending?'saving':on?'disable':'enable'),()=>requestModes({workspaceId:workspace.workspaceId,enabled:!on}),{'data-fleet-toggle':workspace.workspaceId,'aria-pressed':on,disabled:!mode.ready||mode.pending})));}),workspaces.length===0&&empty(t('empty'))));
  }
  const draftBuffers=new Map();
  function DraftEditor(o) {
    const L=language(o), incoming=o.draft,bufferKey=JSON.stringify([incoming.workspaceId,incoming.originSessionId,incoming.id]),buffer=draftBuffers.get(bufferKey);
    const toFields=d=>({goal:d.plan.goal,title:d.plan.title??'',criteria:d.plan.criteria});
    const [base,setBase]=React.useState(buffer?.base||incoming),[values,setValues]=React.useState(()=>buffer?.values||toFields(incoming)),[dirty,setDirty]=React.useState(!!buffer?.dirty),[saving,setSaving]=React.useState(false),[error,setError]=React.useState(null);
    const [editing,setEditing]=React.useState(buffer?.editing||null),[editCrits,setEditCrits]=React.useState(buffer?.editCrits||null);
    const [popout,setPopout]=React.useState(null),[note,setNote]=React.useState(null);
    const [gateForm,setGateForm]=React.useState(buffer?.gateForm||null),[contractForm,setContractForm]=React.useState(buffer?.contractForm||null),[targetForm,setTargetForm]=React.useState(null);
    const [summaryForm,setSummaryForm]=React.useState(buffer?.summaryForm||null),[modelForm,setModelForm]=React.useState(buffer?.modelForm||null),[dcritForm,setDcritForm]=React.useState(buffer?.dcritForm||null);
    const [startPhase,setStartPhase]=React.useState(null);
    const [scheduleOpen,setScheduleOpen]=React.useState(false);
    const [scopeChoice,setScopeChoice]=React.useState(null);
    const scheduleUnavailable=scheduleUnavailableReason(o.data,L);
    const [popRect,setPopRect]=React.useState(null);
    const popPanelRef=React.useRef(null),editorRootRef=React.useRef(null),popTriggerRef=React.useRef(null),popCloseRef=React.useRef(null),detailEdits=React.useRef(new Map());
    const structural=React.useRef(buffer?.structural||null);
    draftBuffers.set(bufferKey,{base,values,dirty,editing,editCrits,gateForm,contractForm,summaryForm,modelForm,dcritForm,structural:structural.current});
    React.useEffect(()=>{o.onDirtyChange?.(!!buffer?.dirty);},[]);
    const current=React.useRef({base,values,dirty,structural:structural.current}), pending=React.useRef(null), version=React.useRef(0);
    current.current={base,values,dirty,structural:structural.current};
    const accept=d=>{const fields=toFields(d);setBase(d);setValues(fields);setDirty(false);setEditing(null);setEditCrits(null);setGateForm(null);setContractForm(null);setTargetForm(null);setSummaryForm(null);setModelForm(null);setDcritForm(null);setStartPhase(null);setScheduleOpen(false);setScopeChoice(null);structural.current=null;current.current={base:d,values:fields,dirty:false,structural:null};draftBuffers.set(bufferKey,{...current.current,editing:null,editCrits:null,summaryForm:null,modelForm:null,dcritForm:null,structural:null});o.onDirtyChange?.(false);};
    React.useEffect(()=>{
      if(!current.current.dirty&&!pending.current&&!editing&&!detailEdits.current.size&&(incoming.revision!==current.current.base.revision||incoming.status!==current.current.base.status)){accept(incoming);setPopout(null);}
    },[incoming.revision,incoming.status,editing]);
    const change=(key,value)=>{version.current++;const next={...current.current.values,[key]:value};current.current={...current.current,values:next,dirty:true};setValues(next);setDirty(true);o.onDirtyChange?.(true);setError(null);};
    const makePlan=state=>{
      // Structural edits (gate policy / task contract / delivery target) clone the whole plan;
      // goal & criteria always come from the tracked inline values so cancelling never leaks a baked-in edit.
      const plan=state.structural?structuredClone(state.structural):{...state.base.plan};
      plan.goal=state.values.goal;plan.criteria=state.values.criteria;
      if(String(state.values.title||'').trim())plan.title=state.values.title;else delete plan.title;
      return plan;
    };
    const applyStructural=fn=>{
      try{
        const next=fn(makePlan(current.current));
        structural.current=next;version.current++;
        current.current={...current.current,dirty:true,structural:next};
        setDirty(true);o.onDirtyChange?.(true);setError(null);setValues(v=>({...v}));
        return true;
      }catch(e){setError(e.message||String(e));return false;}
    };
    async function save() {
      if(pending.current)return pending.current;
      if(scopeChoice)return null;
      if(!['draft','stopped'].includes(incoming.status)||o.busy||o.readOnly)return null;
      if(!current.current.dirty)return current.current.base;
      const state=current.current,stamp=version.current;
      let plan;
      try{
        plan=makePlan(state);
        if(state.values.routing){
          plan=applyRouting(plan,state.values.routing,L);
          const validation=validatePlan(plan,{mode:'save'});
          if(!validation.valid)throw new Error(validation.errors.map(item=>`${item.path} · ${item.message}`).join('\n'));
        }
      }catch(error){setError(error.message);return null;}
      if(!plan.goal.trim()){setError(L('请填写任务目标。','Please enter a goal.'));return null;}
      // P-67：recurring 系列成员先问范围；取消保留输入不保存。一次性按原流程直接保存。
      const choices=ticketSeries(incoming,o.data).filter(needsSaveScope);
      if(choices.length){setPopout(null);setScopeChoice({plan,base:state.base,stamp,choices});return null;}
      return doSave(plan,state.base,stamp,null);
    }
    function doSave(plan,base,stamp,options) {
      setSaving(true);setError(null);
      // Establish the pending promise before invoking a callback that may throw
      // synchronously; otherwise its finally clears the ref before assignment.
      pending.current=Promise.resolve().then(async()=>{
        try{
          const result=await o.onSave(plan,base,options||undefined);
          if(!result)return null;
          setBase(result);current.current={...current.current,base:result};
          if(stamp===version.current)accept(result);
          return result;
        }catch(e){setError(e.message||String(e));return null;}
        finally{pending.current=null;setSaving(false);}
      });
      return pending.current;
    }
    const chooseScope=options=>{
      const held=scopeChoice;setScopeChoice(null);
      if(!held||!options)return;
      if(held.stamp!==version.current){setError(L('输入已更新，请重新保存并选择修改范围。','Your edits changed. Save again to choose their scope.'));return;}
      void doSave(held.plan,held.base,held.stamp,options);
    };
    const editable=['draft','stopped'].includes(incoming.status)&&!o.readOnly,locked=saving||o.busy||!editable,conflict=(dirty||!!editing||detailEdits.current.size>0)&&(incoming.revision!==base.revision||incoming.status!==base.status);
    const viewPlan=makePlan({base,values,dirty,structural:structural.current});
    // P-52: the editor exposes the same start/resume decision as the Ticket page; confirmation stays inline.
    const startable=editable&&!incoming.abandonedAt&&typeof o.onStart==='function';
    const startCheck=startable?validatePlan(viewPlan,{mode:'start'}):{valid:true,errors:[]};
    const nodes=list(viewPlan.nodes),gates=list(viewPlan.gates),agents=viewPlan.agents||{};
    const criteria=list(values.criteria),deliverables=list(viewPlan.deliverables),registry=list(projectTicket(base).deliverables);
    const agentFor=node=>Object.hasOwn(agents,node.agentId)?agents[node.agentId]:null;
    const modelCatalog=o.data?.catalog?.modelCatalog??o.catalog?.modelCatalog;
    const firstSentence=value=>String(value||'').split(/[。．!！?？;；\n]/)[0].trim();
    const levels=graphLevels(nodes,gates,viewPlan.logicGates);
    const lines=s=>String(s??'').split('\n').map(x=>x.trim()).filter(Boolean);
    const openEdit=kind=>{
      if(locked||editing===kind)return;
      setNote(null);setEditing(kind);
      if(kind==='crit')setEditCrits([...criteria]);
      if(kind==='target')setTargetForm(viewPlan.inputs?.deliveryTarget??'');
      if(kind.startsWith('gate:')){const g=gates.find(x=>x.id===kind.slice(5));setGateForm({gateId:kind.slice(5),requireEvidence:!!g?.requireEvidence,reworkEnabled:g?.rework?g.rework.maxRounds!==0:true,maxRounds:g?.rework?.maxRounds??3,targetNodes:(g?.rework?.targetNodes??[]).join('\n'),scopeNote:g?.rework?.scopeNote??'',reworkSession:g?.rework?.reworkSession??'reuse'});}
      if(kind.startsWith('review:')){
        const g=gates.find(item=>item.id===kind.slice(7));
        setGateForm({summary:g.reviewTask?.summary||'',inputs:list(g.reviewTask?.inputs).join('\n'),checks:list(g.reviewTask?.checks).join('\n')});
      }
      if(kind.startsWith('gmodel:')){
        const selection=gates.find(item=>item.id===kind.slice(7)).modelSelection;
        setModelForm({provider:selection?.provider||'',model:selection?.model||'',reasoningEffort:selection?.reasoningEffort||''});
      }
      if(kind.startsWith('caps:')){
        const g=gates.find(item=>item.id===kind.slice(5)), reviewer=nodes.find(item=>item.id===g.reviewer.nodeId);
        setGateForm({inherit:!Array.isArray(g.plannedCapabilities),caps:structuredClone(g.plannedCapabilities??reviewer?.task?.plannedCapabilities??[])});
      }
      if(kind.startsWith('contract:')){const n=nodes.find(x=>x.id===kind.slice(9)),c=n?.task?.contract;setContractForm({nodeId:kind.slice(9),acceptance:(c?.acceptance??[]).join('\n'),scopeIn:(c?.scope?.in??[]).join('\n'),scopeOut:(c?.scope?.out??[]).join('\n'),verify:(c?.verify??[]).join('\n')});}
      if(kind.startsWith('summary:')){const n=nodes.find(x=>x.id===kind.slice(8));setSummaryForm(n?.task?.summary??'');}
      if(kind.startsWith('model:')){const n=nodes.find(x=>x.id===kind.slice(6));setModelForm({provider:n?.modelSelection?.provider||'',model:n?.modelSelection?.model||'',reasoningEffort:n?.modelSelection?.reasoningEffort||''});}
      if(kind.startsWith('amodel:')){const a=agents[kind.slice(7)];setModelForm({provider:a?.profile?.modelSelection?.provider||'',model:a?.profile?.modelSelection?.model||'',reasoningEffort:a?.profile?.modelSelection?.reasoningEffort||''});}
      if(kind.startsWith('dcrit:')){const item=viewPlan.deliverables?.[Number(kind.slice(6))];setDcritForm([...(typeof item==='string'?[]:list(item?.criteria))]);}
      if(!['gate:','review:','caps:','gmodel:','contract:','summary:','model:','amodel:','dcrit:'].some(prefix=>kind.startsWith(prefix)))setPopout(null);
    };
    const cancelEdit=()=>{if(editing&&/^(gate|review|caps|gmodel|contract|summary|model|amodel):/.test(editing))detailEdits.current.delete(popout);if(dirty&&!saving){const fields=toFields(base);structural.current=null;current.current={...current.current,values:fields,dirty:false,structural:null};setValues(fields);setDirty(false);o.onDirtyChange?.(false);}setEditing(null);setEditCrits(null);setGateForm(null);setContractForm(null);setTargetForm(null);setSummaryForm(null);setModelForm(null);setDcritForm(null);};
    const applyEdit=()=>{
      if(editing?.startsWith('gate:')&&gateForm){
        const ok=applyStructural(p=>applyGatePolicy(p,gateForm.gateId,{requireEvidence:gateForm.requireEvidence,rework:gateForm.reworkEnabled?{maxRounds:Number(gateForm.maxRounds),targetNodes:lines(gateForm.targetNodes),scopeNote:gateForm.scopeNote,reworkSession:gateForm.reworkSession}:{maxRounds:0}}));
        if(!ok)return;clearDetail(popout);setGateForm(null);
      }else if(['review','caps','gmodel'].includes(detailKind)){
        const field={review:'reviewTask',caps:'plannedCapabilities',gmodel:'modelSelection'}[detailKind];
        const ok=applyStructural(plan=>{
          const next=structuredClone(plan),gate=next.gates.find(g=>g.id===popGate.id);
          let value;
          if(detailKind==='review'){
            const summary=gateForm.summary.trim(),inputs=lines(gateForm.inputs),checks=lines(gateForm.checks);
            value={...(summary?{summary}:{}),inputs,checks};
          }else if(detailKind==='gmodel'){
            value=modelForm.provider||modelForm.model?validSelection(modelForm):null;
          }else if(!gateForm.inherit){
            value=gateForm.caps.map(cap=>({kind:cap.kind,id:cap.id.trim(),purpose:cap.purpose.trim(),...(cap.name?.trim()?{name:cap.name.trim()}:{}),...(cleanList(cap.tools).length?{tools:cleanList(cap.tools).map(tool=>tool.trim())}:{})}));
          }
          if(value==null)delete gate[field];else gate[field]=value;
          const validation=validatePlan(next,{mode:'save'});
          if(!validation.valid)throw new Error(validation.errors.map(e=>e.message).join('\n'));
          return next;
        });
        if(!ok)return;clearDetail(popout);setGateForm(null);setModelForm(null);
      }else if(editing?.startsWith('contract:')&&contractForm){
        const ok=applyStructural(p=>applyTaskContract(p,contractForm.nodeId,{acceptance:lines(contractForm.acceptance),scope:{in:lines(contractForm.scopeIn),out:lines(contractForm.scopeOut)},verify:lines(contractForm.verify)}));
        if(!ok)return;clearDetail(popout);setContractForm(null);
      }else if(editing==='target'){
        const ok=applyStructural(p=>applyDeliveryTarget(p,targetForm));if(!ok)return;setTargetForm(null);
      }else if(editing?.startsWith('summary:')&&summaryForm!==null){
        const ok=applyStructural(p=>applyTaskSummary(p,editing.slice(8),summaryForm));if(!ok)return;clearDetail(popout);setSummaryForm(null);
      }else if(editing?.startsWith('model:')&&modelForm){
        const ok=applyStructural(p=>applyNodeModelSelection(p,editing.slice(6),modelForm.provider&&modelForm.model?modelForm:null));if(!ok)return;clearDetail(popout);setModelForm(null);
      }else if(editing?.startsWith('amodel:')&&modelForm){
        const ok=applyStructural(p=>applyAgentModelSelection(p,editing.slice(7),modelForm.provider&&modelForm.model?modelForm:null));if(!ok)return;clearDetail(popout);setModelForm(null);
      }else if(editing?.startsWith('dcrit:')&&dcritForm){
        const ok=applyStructural(p=>applyDeliverableCriteria(p,Number(editing.slice(6)),dcritForm));if(!ok)return;setDcritForm(null);
      }
      setEditing(null);setEditCrits(null);void save();
    };
    const ibar=()=>h('div',{className:'fl-ibar'},button(L('取消','Cancel'),cancelEdit,{className:'fl-btn fl-btn-ghost',disabled:saving}),button(L('应用','Apply'),applyEdit,{className:'fl-btn fl-btn-primary',disabled:locked}));
    const setCrits=next=>{setEditCrits(next);change('criteria',next);};
    const agentIcon=()=>h('svg',{className:'fl-gic fl-ntype-icon fl-ntype-exec',viewBox:'0 0 20 20','aria-hidden':true},h('path',{d:'M4 3 L17 10 4 17 Z',fill:'currentColor'}));
    const gateIcon=()=>h('svg',{className:'fl-gic fl-ntype-icon fl-ntype-gate',viewBox:'0 0 20 20','aria-hidden':true},h('path',{d:'M10 2 L16.9 6 L16.9 14 L10 18 L3.1 14 L3.1 6 Z',fill:'currentColor'}));
    const nodeCard=node=>{const assigned=agentFor(node),agent=assigned?.name||node.agentId||L('未分配','Unassigned'),known=!!assigned;
      return h('button',{type:'button',className:'fl-gcard',key:node.id,'data-fleet-draft-node':node.id,onClick:event=>openDetail(`node:${node.id}`,event.currentTarget)},
        agentIcon(),
        h('span',{className:'fl-gbody'},
          h('span',{className:'fl-row'},h('strong',null,agent),badge(known?L('已分配','assigned'):L('未分配','unassigned'),known?'success':'waiting')),
          h('span',{className:'fl-small fl-muted','data-fleet-draft-node-summary':node.id},node.task?.summary||firstSentence(node.task?.prompt)||node.id),
          modelLine(o,node,agents,L),
          planChips(node.task,L),
          h('span',{className:'fl-small fl-muted fl-mono'},node.id)));};
    // An Agent-reviewed gate carries the same anatomy as an Agent block — reviewer
    // name, its one-line review statement, the effective model/effort and the planned use
    // declared on the reviewer node — while the icon stays the review-gate diamond. Only
    // the trailing mono line states the gate id and its sources.
    const gateModelLine=(gate,node)=>{const m=modelDisplay(o,gate.modelSelection?{...node,modelSelection:gate.modelSelection}:node,agents,L);
      return h('span',{className:'fl-row fl-small fl-muted fl-model','data-fleet-gate-model':gate.id},h('span',{className:'fl-mono'},m.text),m.effort?badge(m.effort,'neutral'):null,!m.configured?h('span',null,L('默认','default')):null);};
    const gateCard=gate=>{
      const reviewNode=gate.reviewer?.kind==='agent'?nodes.find(n=>n.id===gate.reviewer.nodeId)||null:null;
      const reviewAgent=reviewNode?agentFor(reviewNode):null;
      return h('button',{type:'button',className:'fl-gcard',key:gate.id,'data-fleet-draft-gate':gate.id,onClick:event=>openDetail(`gate:${gate.id}`,event.currentTarget)},
        gateIcon(),
        h('span',{className:'fl-gbody'},
          gate.reviewer?.kind==='agent'?h(React.Fragment,null,
            h('span',{className:'fl-row','data-fleet-gate-agent':gate.id},h('strong',null,reviewAgent?.name||reviewNode?.agentId||gate.reviewer.nodeId),badge(reviewAgent?L('已分配','assigned'):L('未分配','unassigned'),reviewAgent?'success':'waiting')),
            h('span',{className:'fl-small fl-muted','data-fleet-draft-gate-summary':gate.id},gate.reviewTask?.summary||firstSentence(gate.reviewTask?.checks?.[0]||gate.rework?.scopeNote)||L('审核上游交付','Review the upstream delivery')),
            gateModelLine(gate,reviewNode),
            planChips({plannedCapabilities:gate.plannedCapabilities??reviewNode?.task?.plannedCapabilities},L),
            h('span',{className:'fl-small fl-muted fl-mono','data-fleet-draft-gate-id':gate.id},`${gate.id} · ${L('来源','From')}：${list(gate.from).join(' · ')||'—'}`))
          :h(React.Fragment,null,
            h('span',{className:'fl-row'},h('strong',null,gate.id),badge(L('人工审核','human review'),'waiting')),
            h('span',{className:'fl-small fl-muted'},`${L('来源','From')}：${list(gate.from).join(' · ')||'—'}`))));
    };
    const popNode=popout?.startsWith('node:')?nodes.find(n=>n.id===popout.slice(5)):null;
    const popGate=popout?.startsWith('gate:')?gates.find(g=>g.id===popout.slice(5)):null;
    const popReviewNode=popGate?.reviewer?.kind==='agent'?nodes.find(n=>n.id===popGate.reviewer.nodeId):null;
    const popAgent=popNode?agentFor(popNode):null;
    // P-63: node/gate details open as a panel anchored inside the hosting surface
    // (sidebar artifact pane or Dashboard dialog), never as a global centered popup.
    // The header with the close button stays fixed while only the body scrolls;
    // clicking anywhere outside the panel or pressing Escape closes it.
    const detailFormSetters={gate:setGateForm,review:setGateForm,caps:setGateForm,gmodel:setModelForm,contract:setContractForm,summary:setSummaryForm,model:setModelForm,amodel:setModelForm};
    const detailKind=editing?.split(':')[0];
    const clearDetail=id=>detailEdits.current.delete(id);
    const openDetail=(id,trigger)=>{
      const saved=detailEdits.current.get(id);
      popTriggerRef.current=trigger;
      setPopRect(null);
      setPopout(id);
      setNote(null);
      if(saved){
        setEditing(saved.editing);
        detailFormSetters[saved.kind](saved.form);
      }else if(Object.hasOwn(detailFormSetters,detailKind))setEditing(null);
    };
    const closePop=()=>{
      if(Object.hasOwn(detailFormSetters,detailKind)){
        const forms={gate:gateForm,review:gateForm,caps:gateForm,gmodel:modelForm,contract:contractForm,summary:summaryForm,model:modelForm,amodel:modelForm};
        detailEdits.current.set(popout,{editing,kind:detailKind,form:forms[detailKind]});
      }
      setPopout(null);
    };
    const closeFromButton=()=>{
      closePop();
      popTriggerRef.current?.focus({preventScroll:true});
    };
    popCloseRef.current=closePop;
    // The panel only renders once popRect is measured, so a plain effect cannot flash
    // a wrong position and stays silent under renderToStaticMarkup unit tests.
    React.useEffect(()=>{
      if(!popout){popTriggerRef.current=null;return;}
      const root=editorRootRef.current;if(!root)return;
      const artifact=root.closest('[data-fleet-draft-artifact]');
      const surface=artifact||root.closest('.fl-dialog')||root.closest('.dsh-fleet-shell')||root;

      const measure=()=>{
        const r=surface.getBoundingClientRect(),vw=window.innerWidth,vh=window.innerHeight;
        let left=Math.max(0,r.left),top=Math.max(0,r.top),right=Math.min(vw,r.right),bottom=Math.min(vh,r.bottom);
        // Intersect with every clipping ancestor so the panel never covers host chrome
        // (tab bars, headers) when the hosting pane itself is scrolled.
        for(let p=surface.parentElement;p;p=p.parentElement){
          const s=getComputedStyle(p);
          if(/(auto|scroll|hidden|clip)/.test(s.overflowX+s.overflowY)){
            const c=p.getBoundingClientRect();
            left=Math.max(left,c.left);top=Math.max(top,c.top);right=Math.min(right,c.right);bottom=Math.min(bottom,c.bottom);
          }
        }
        // Sidebar mode positions absolutely inside the pane, so compensate its scroll
        // to keep the panel pinned to the visible area; dialog mode uses fixed coords.
        const host=artifact?surface.getBoundingClientRect():null;
        setPopRect({left:left-(host?host.left-surface.scrollLeft:0),top:top-(host?host.top-surface.scrollTop:0),width:Math.max(0,right-left),height:Math.max(0,bottom-top),id:popout});
      };
      measure();
      const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);
      observer?.observe(surface);
      window.addEventListener('resize',measure);
      document.addEventListener('scroll',measure,true);
      const restore=keyboard=>{popCloseRef.current?.();if(keyboard){const target=popTriggerRef.current;if(target?.isConnected)target.focus({preventScroll:true});}};
      const onKey=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();restore(true);}};
      const onPointer=e=>{const panel=popPanelRef.current;if(panel&&e.target instanceof Node&&!panel.contains(e.target))restore(false);};
      document.addEventListener('keydown',onKey);
      document.addEventListener('pointerdown',onPointer);
      return()=>{observer?.disconnect();window.removeEventListener('resize',measure);document.removeEventListener('scroll',measure,true);document.removeEventListener('keydown',onKey);document.removeEventListener('pointerdown',onPointer);};
    },[popout]);
    // The rect is tagged with the popout id so a reopen never flashes at the previous
    // open's position: the panel renders only after it was measured for this open.
    const popReady=!!popout&&!!popRect&&popRect.id===popout;
    const popStyle=popReady?{left:popRect.left+8,top:popRect.top+8,width:Math.max(popRect.width-16,0),height:Math.max(popRect.height-16,0)}:null;
    const modelSettings=(node,{assignedAgent,kind='model',prefix}={})=>h('div',{className:'fl-spaced','data-fleet-node-model-edit':node.id},
          h('div',{className:'fl-row fl-between'},h('h3',null,L('模型 / Effort','Model / effort')),editable&&list(modelCatalog?.groups).length>0&&button(editing===`${kind}:${node.id}`?'✕':'✎',()=>editing===`${kind}:${node.id}`?cancelEdit():openEdit(`${kind}:${node.id}`),{className:'fl-btn fl-btn-ghost','aria-label':kind==='gmodel'?L('编辑审核模型','Edit review model'):L('编辑节点模型','Edit node model'),[kind==='gmodel'?'data-fleet-gmodel-edit':'data-fleet-node-model-edit-btn']:node.id})),
          kind==='model'&&kv(L('有效选择','Effective'),(()=>{const m=modelDisplay(o,node,agents,L);return h('span',{className:'fl-row'},h('span',{className:'fl-mono'},m.text),m.effort?badge(m.effort,'neutral'):null,badge(L(...modelSourceNames[m.source]),m.configured?'waiting':'neutral'));})()),
          editing===`${kind}:${node.id}`&&modelForm?h('div',{className:'fl-stack'},
            modelSelects(modelCatalog,modelForm,setModelForm,L,prefix),
            h('div',{className:'fl-row'},button(L('恢复继承','Restore inheritance'),()=>{const ok=applyStructural(p=>kind==='gmodel'?applyGateModelSelection(p,node.id,null):applyNodeModelSelection(p,node.id,null));if(ok){clearDetail(popout);setModelForm(null);setEditing(null);void save();}},{className:'fl-btn fl-btn-ghost',disabled:locked||!node.modelSelection,[kind==='gmodel'?'data-fleet-gate-model-clear':'data-fleet-model-clear']:node.id}),ibar())):null,
          list(modelCatalog?.groups).length===0&&h('p',{className:'fl-help'},L('宿主模型目录不可用，暂不能配置模型。','The host model catalog is unavailable; model configuration is temporarily disabled.')),
          assignedAgent&&h('div',{className:'fl-spaced','data-fleet-agent-model':node.agentId},
            h('div',{className:'fl-row fl-between'},h('span',{className:'fl-small fl-muted'},`${L('Agent 级','Agent level')}: ${assignedAgent.profile?.modelSelection?`${assignedAgent.profile.modelSelection.provider}/${assignedAgent.profile.modelSelection.model}${assignedAgent.profile.modelSelection.reasoningEffort?` · ${assignedAgent.profile.modelSelection.reasoningEffort}`:''}`:L('继承宿主默认','inherits host default')}`),editable&&list(modelCatalog?.groups).length>0&&button(editing===`amodel:${node.agentId}`?'✕':'✎',()=>editing===`amodel:${node.agentId}`?cancelEdit():openEdit(`amodel:${node.agentId}`),{className:'fl-btn fl-btn-ghost','aria-label':L('编辑 Agent 模型','Edit agent model'),'data-fleet-agent-model-edit':node.agentId})),
            editing===`amodel:${node.agentId}`&&modelForm?h('div',{className:'fl-stack'},modelSelects(modelCatalog,modelForm,setModelForm,L,'agent-'),ibar()):null));
    function reviewControls(g){
      if(!editable)return {};
      const key=kind=>`${kind}:${g.id}`;
      const editButton=(kind,label)=>button(label,()=>openEdit(key(kind)),{className:'fl-btn fl-btn-ghost',disabled:locked,[`data-fleet-${kind}-edit`]:g.id});
      const field=(label,value,update,props={})=>h('label',{className:'fl-field'},label,h('textarea',{className:'fl-input',rows:2,value,disabled:locked,'aria-label':label,onChange:e=>update(e.target.value),...props}));
      const editingReview=editing===key('review')&&gateForm;

      const inherited=L('继承审核节点','Inherit reviewer node');
      const updateCap=(index,key,value)=>setGateForm({...gateForm,caps:gateForm.caps.map((item,i)=>i===index?{...item,[key]:value}:item)});
      const capabilityEditor=()=>h('div',{className:'fl-stack'},
        h('label',{className:'fl-row'},h('input',{type:'checkbox',checked:gateForm.inherit,disabled:locked,onChange:e=>setGateForm({...gateForm,inherit:e.target.checked}),'data-fleet-caps-inherit':''}),inherited),
        !gateForm.inherit&&h(React.Fragment,null,...gateForm.caps.map((cap,i)=>h('fieldset',{key:i,className:'fl-stack',disabled:locked},
          h('label',null,L('类型','Type'),h('select',{className:'fl-input',value:cap.kind,onChange:e=>updateCap(i,'kind',e.target.value)},...Object.entries(capabilityKindNames).map(([kind,names])=>h('option',{key:kind,value:kind},L(...names))))),
          field('ID',cap.id,value=>updateCap(i,'id',value)),field(L('名称（可选）','Name (optional)'),cap.name||'',value=>updateCap(i,'name',value)),
          field(L('用途','Purpose'),cap.purpose,value=>updateCap(i,'purpose',value)),field(L('关联工具（每行一个）','Related tools (one per line)'),list(cap.tools).join('\n'),value=>updateCap(i,'tools',value.split('\n'))),
          button(L('移除依赖','Remove dependency'),()=>setGateForm({...gateForm,caps:gateForm.caps.filter((_,n)=>n!==i)})))),
          button(L('添加依赖','Add dependency'),()=>setGateForm({...gateForm,caps:[...gateForm.caps,{kind:'skill',id:'',purpose:''}]}),{disabled:locked})),ibar());
      return {
        model:modelSettings(g,{kind:'gmodel',prefix:'gate-'}),
        inputs:editingReview?h(React.Fragment,null,field(L('审核任务','Review task'),gateForm.summary,value=>setGateForm({...gateForm,summary:value})),field(L('输入材料（每行一条）','Input materials (one per line)'),gateForm.inputs,value=>setGateForm({...gateForm,inputs:value}))):editButton('review',L('编辑审核任务','Edit review task')),
        checks:editingReview?h(React.Fragment,null,field(L('检查项（每行一条）','Checks (one per line)'),gateForm.checks,value=>setGateForm({...gateForm,checks:value})),ibar()):null,
        dependencies:editing===key('caps')&&gateForm?capabilityEditor():editButton('caps',L('编辑此 Gate 的依赖','Edit dependencies for this gate'))};
    }
    const popCard=popReady&&popNode?h('div',{className:'fl-popout',ref:popPanelRef,role:'dialog','aria-label':L('节点详情','Node details'),style:popStyle},
        h('div',{className:'fl-pophead'},row(h('strong',null,popAgent?.name||popNode.agentId||popNode.id),h('span',{className:'fl-small fl-muted'},L('节点详情','Node details')),h('span',{style:{marginLeft:'auto'}},button('×',closeFromButton,{className:'fl-btn fl-btn-ghost','aria-label':L('关闭','Close')})))),
        h('div',{className:'fl-popbody'},
        kv('Node ID',popNode.id),kv('Agent ID',popNode.agentId||L('未分配','Unassigned')),kv(L('角色','Role'),popNode.role||'—'),kv(L('依赖','Depends on'),list(popNode.dependsOn).join(' · ')||'—'),kv(L('任务','Task'),popNode.task?.prompt||'—'),
        popAgent?.profile?.instructions?kv(L('智能体指令','Agent instructions'),popAgent.profile.instructions):null,
        kv(L('DSH 预设','DSH preset'),popAgent?.profile?.agentPreset||L('继承默认','Host default')),
        (popNode.task?.summary||editable)&&h('div',{className:'fl-spaced','data-fleet-node-summary-edit':popNode.id},
          h('div',{className:'fl-row fl-between'},h('h3',null,L('任务陈述（一句话）','Task summary (one sentence)')),editable&&button(editing===`summary:${popNode.id}`?'✕':'✎',()=>editing===`summary:${popNode.id}`?cancelEdit():openEdit(`summary:${popNode.id}`),{className:'fl-btn fl-btn-ghost','aria-label':L('编辑任务陈述','Edit task summary'),'data-fleet-summary-edit':popNode.id})),
          editing===`summary:${popNode.id}`?h('div',{className:'fl-iedit'},h('textarea',{className:'fl-input',rows:2,value:summaryForm??'',disabled:locked,placeholder:L('我会……，达成……','I will ..., achieving ...'),onChange:e=>setSummaryForm(e.target.value),'data-fleet-summary-input':''}),ibar())
            :h('p',{className:'fl-small'},popNode.task?.summary||L('尚无一句话陈述 · 高层视图将回退任务首句','No one-sentence summary yet — high-level cards fall back to the task’s first sentence'))),
        nodePlanSections(popNode,{deliverables:registry},{L}),
         modelSettings(popNode,{assignedAgent:popAgent}),
        (popNode.task?.contract||editable)&&h('div',{className:'fl-spaced','data-fleet-node-contract':popNode.id},
          h('div',{className:'fl-row fl-between'},h('h3',null,L('业务合同','Task contract')),editable&&button(editing===`contract:${popNode.id}`?'✕':'✎',()=>editing===`contract:${popNode.id}`?cancelEdit():openEdit(`contract:${popNode.id}`),{className:'fl-btn fl-btn-ghost','aria-label':L('编辑业务合同','Edit task contract'),'data-fleet-contract-edit':popNode.id})),
          editing===`contract:${popNode.id}`&&contractForm?h('div',{className:'fl-stack'},
            h('label',{className:'fl-small'},L('验收说明（每行一条）','Acceptance (one per line)'),h('textarea',{className:'fl-input',rows:3,value:contractForm.acceptance,disabled:locked,onChange:e=>setContractForm({...contractForm,acceptance:e.target.value}),'data-fleet-contract-acceptance':''})),
            h('label',{className:'fl-small'},L('范围内（每行一条）','In scope (one per line)'),h('textarea',{className:'fl-input',rows:2,value:contractForm.scopeIn,disabled:locked,onChange:e=>setContractForm({...contractForm,scopeIn:e.target.value}),'data-fleet-contract-in':''})),
            h('label',{className:'fl-small'},L('范围外（每行一条）','Out of scope (one per line)'),h('textarea',{className:'fl-input',rows:2,value:contractForm.scopeOut,disabled:locked,onChange:e=>setContractForm({...contractForm,scopeOut:e.target.value}),'data-fleet-contract-out':''})),
            h('label',{className:'fl-small'},L('建议验证（每行一条）','Suggested verification (one per line)'),h('textarea',{className:'fl-input',rows:2,value:contractForm.verify,disabled:locked,onChange:e=>setContractForm({...contractForm,verify:e.target.value}),'data-fleet-contract-verify':''})),
            ibar())
          :h(React.Fragment,null,
            evidenceList(L('验收说明','Acceptance'),popNode.task?.contract?.acceptance),
            popNode.task?.contract?.scope&&h('div',{className:'fl-spaced'},h('p',{className:'fl-small fl-muted'},L('范围提示（非写锁）','Scope hints (not a write lock)')),readValue(popNode.task.contract.scope)),
            evidenceList(L('建议验证','Suggested verification'),popNode.task?.contract?.verify,true))),
        h('details',null,h('summary',null,L('完整任务与配置','Full task and profile')),readValue({task:popNode.task,profile:popAgent?.profile})),
        editable&&row(button(L('编辑配置','Edit configuration'),()=>setNote(L('结构化配置（节点、智能体和关卡）请在对话中描述，由 Agent 更新此 Ticket。','Describe structural changes (nodes, agents and gates) in the conversation; the Agent updates this Ticket.')))),
        popAgent&&typeof o.openDialog==='function'&&row(button(L('保存为 Agent 模板','Save as Agent template'),()=>o.openDialog({kind:'template-from-node',ticketId:base.id,nodeId:popNode.id}),{className:'fl-btn','data-fleet-save-agent-pop':popNode.id,disabled:o.busy}))))
      :popReady&&popGate?h('div',{className:'fl-popout',ref:popPanelRef,role:'dialog','aria-label':L('关卡详情','Gate details'),style:popStyle},
        h('div',{className:'fl-pophead'},row(h('strong',null,popGate.id),h('span',{className:'fl-small fl-muted'},L('关卡详情','Gate details')),h('span',{style:{marginLeft:'auto'}},editable&&button(editing===`gate:${popGate.id}`?'✕':'✎',()=>editing===`gate:${popGate.id}`?cancelEdit():openEdit(`gate:${popGate.id}`),{className:'fl-btn fl-btn-ghost','aria-label':L('编辑关卡策略','Edit gate policy'),'data-fleet-gate-edit':popGate.id}),button('×',closeFromButton,{className:'fl-btn fl-btn-ghost','aria-label':L('关闭','Close')})))),
        h('div',{className:'fl-popbody'},
        popGate.reviewer?.kind==='human'&&h(React.Fragment,null,kv(L('审核','Reviewer'),L('你（人工）','You (human)')),kv(L('来源','From'),list(popGate.from).join(' · ')||'—'),kv(L('去向','To'),list(popGate.to).join(' · ')||'—')),
        popGate.reviewer?.kind==='agent'&&gatePlanSections(popGate,popReviewNode,agents,o,reviewControls(popGate)),
        popReviewNode&&popReviewNode.agentId!=null&&agents[popReviewNode.agentId]&&typeof o.openDialog==='function'&&row(button(L('保存审核 Agent 为模板','Save reviewer Agent as template'),()=>o.openDialog({kind:'template-from-node',ticketId:base.id,nodeId:popReviewNode.id}),{className:'fl-btn','data-fleet-save-agent-gate':popReviewNode.id,disabled:o.busy})),
        editing===`gate:${popGate.id}`&&gateForm?h('div',{className:'fl-stack fl-spaced'},
          h('label',{className:'fl-row fl-small'},h('input',{type:'checkbox',checked:gateForm.requireEvidence,disabled:locked,onChange:e=>setGateForm({...gateForm,requireEvidence:e.target.checked}),'data-fleet-gate-evidence':''}),L('必须提交结构化证据','Structured evidence required')),
          h('label',{className:'fl-row fl-small'},h('input',{type:'checkbox',checked:gateForm.reworkEnabled,disabled:locked,onChange:e=>setGateForm({...gateForm,reworkEnabled:e.target.checked}),'data-fleet-gate-rework':''}),L('退回自动返工','Auto rework on return')),
          gateForm.reworkEnabled&&h(React.Fragment,null,
            h('label',{className:'fl-small'},L('最大自动返工轮数（0 关闭）','Max auto rework rounds (0 disables)'),h('input',{className:'fl-input',type:'number',min:0,value:gateForm.maxRounds,disabled:locked,onChange:e=>setGateForm({...gateForm,maxRounds:e.target.value}),'data-fleet-gate-maxrounds':''})),
            h('label',{className:'fl-small'},L('返工会话','Rework session'),h('select',{className:'fl-input',value:gateForm.reworkSession,disabled:locked,onChange:e=>setGateForm({...gateForm,reworkSession:e.target.value}),'data-fleet-gate-reworksession':''},h('option',{value:'reuse'},L('复用上一轮会话','Reuse previous session')),h('option',{value:'new'},L('每次新开会话','New session each round')))),
            h('label',{className:'fl-small'},L('返工目标节点（每行一个 ID，缺省来源节点）','Rework target nodes (one ID per line; default: source nodes)'),h('textarea',{className:'fl-input',rows:2,value:gateForm.targetNodes,disabled:locked,onChange:e=>setGateForm({...gateForm,targetNodes:e.target.value}),'data-fleet-gate-targets':''})),
            h('label',{className:'fl-small'},L('返工范围说明','Rework scope note'),h('textarea',{className:'fl-input',rows:2,value:gateForm.scopeNote,disabled:locked,onChange:e=>setGateForm({...gateForm,scopeNote:e.target.value}),'data-fleet-gate-scopenote':''}))),
          ibar())
        :h(React.Fragment,null,
          kv(L('结构化证据','Structured evidence'),popGate.requireEvidence?L('必须提交','Required'):L('不强制','Optional')),
          kv(L('返工策略','Rework policy'),(()=>{const r=popGate.rework,isAgent=popGate.reviewer?.kind==='agent',rounds=r?.maxRounds??(isAgent?3:0),on=isAgent?rounds>0:r?.maxRounds!==0;return on?(isAgent?L(`开启 · 自动返工上限 ${rounds} 轮`,`Enabled · auto rework capped at ${rounds} rounds`):L('开启 · 人工退回无限次','Enabled · unlimited human returns')):L('关闭','Disabled');})()),
          kv(L('返工会话','Rework session'),popGate.rework?.reworkSession==='new'?L('每次新开','New each round'):L('复用上一轮会话','Reuse previous session')),
          list(popGate.rework?.targetNodes).length>0&&kv(L('返工目标','Rework targets'),popGate.rework.targetNodes.join(' · ')),
          popGate.rework?.scopeNote&&kv(L('范围说明','Scope note'),popGate.rework.scopeNote)))):null;
    const titleText=values.title?firstSentence(values.title):readableTitle(values.goal);
    return h('div',{className:'fl-content',ref:editorRootRef,'data-fleet-draft-editor':base.id},
      h('header',{className:'fl-head'},h('div',null,h('h2',null,incoming.status==='draft'?L('任务草稿','Ticket draft'):L('任务计划','Ticket plan')),h('p',{className:'fl-mono'},`${base.id} · v${!editable?incoming.revision:base.revision}`))),
      h('div',{className:'fl-draft'},
        h('div',{className:'fl-dcard'},
          h('div',{className:'fl-row',style:{alignItems:'flex-start',justifyContent:'space-between'}},
            editing==='title'?h('div',{style:{display:'grid',gap:8,flex:'1 1 auto',minWidth:0}},
              h('input',{name:'title',className:'fl-dtitle',value:values.title,disabled:locked,'aria-label':L('标题','Title'),placeholder:readableTitle(values.goal)||L('标题（独立于任务目标）','Title (independent of goal)'),onChange:e=>change('title',e.target.value),onKeyDown:e=>{if(e.key==='Enter'){e.preventDefault();applyEdit();}else if(e.key==='Escape')cancelEdit();}}),ibar())
              :h('button',{type:'button',className:'fl-dtitle',disabled:locked,onClick:()=>openEdit('title'),'aria-label':L('标题','Title'),title:L('标题：独立于任务目标的显示名称','Title: display name independent of the goal')},titleText?`${titleText}${titleText.length<String(values.title||values.goal).length?'…':''}`:L('（未命名）','(untitled)')),
            conflict?badge(L('版本冲突','Conflict'),'danger'):status(incoming.status,L)),
          h('div',{className:'fl-row fl-small fl-muted'},h('code',{className:'fl-mono'},`${base.id.slice(0,8)}…`),h('span',null,`v${!editable?incoming.revision:base.revision}`)),
          seriesBadges(incoming,o.data,L,o.onOpenSeries,'draft')),
        !editable&&h('div',{className:'fl-dcard'},h('p',{role:'status'},['running','stop-requested'].includes(incoming.status)?L('执行期间配置已锁定。完全停止后可继续编辑同一任务。','Configuration is locked during execution. Edit this Ticket after it has fully stopped.'):L('此任务为只读，执行和交付记录已保留。','This Ticket is read-only; execution and delivery records are retained.')),
          dirty&&h('p',null,L('以下本地修改尚未保存，已保留供恢复。','These local edits have not been saved and remain available for recovery.')),
          dirty&&h('pre',{'data-fleet-unsaved-recovery':''},json(values)),
          o.onOpenTicket&&button(L('打开任务','Open Ticket'),()=>o.onOpenTicket(incoming.id),{className:'fl-btn fl-btn-primary'})),
        incoming.status==='stopped'&&h('p',{className:'fl-help'},L('修改仅用于后续执行；既有轮次和已完成结果保持原依据。','Edits apply to subsequent execution; previous attempts and completed results keep their original configuration.')), 
        h('div',{className:'fl-dcard'},
          h('div',{className:'fl-dsec'},L('任务结论','Task brief')),
          h('div',{className:'fl-dk'},L('任务目标','Goal')),
          editing==='goal'?h('div',{className:'fl-iedit'},h('textarea',{name:'goal',value:values.goal,disabled:locked,rows:3,onChange:e=>change('goal',e.target.value),onKeyDown:e=>{if(e.key==='Escape')cancelEdit();}}),ibar())
            :h('button',{type:'button',className:'fl-eblock',disabled:locked,onClick:()=>openEdit('goal')},h('p',null,values.goal||L('（无目标）','(no goal)'))),
          h('div',{className:'fl-dk'},L('交付物','Deliverables')),
          registry.length?h('div',{className:'fl-stack'},...registry.map(item=>{const raw=viewPlan.deliverables?.[item.index],view=typeof raw==='string'?{label:raw,spec:raw,criteria:[]}:{...(raw||{}),spec:raw?.text},crits=list(view.criteria);
            return h('div',{key:item.index,className:'fl-notice','data-fleet-draft-deliverable':item.index},
            h('div',{className:'fl-row fl-between'},h('strong',null,item.label),badge(L(...(deliverableStatusNames[item.reviewStatus]||[item.reviewStatus,item.reviewStatus])),deliverableStatusTones[item.reviewStatus]||'neutral')),
            view.description&&h('p',{className:'fl-small'},view.description),
            h('div',{className:'fl-row fl-between'},h('span',{className:'fl-small fl-muted'},L('验收标准','Acceptance criteria')),editable&&button(editing===`dcrit:${item.index}`?'✕':'✎',()=>editing===`dcrit:${item.index}`?cancelEdit():openEdit(`dcrit:${item.index}`),{className:'fl-btn fl-btn-ghost','aria-label':L('编辑这项交付物的标准','Edit this deliverable’s criteria'),'data-fleet-dcrit-edit':item.index})),
            editing===`dcrit:${item.index}`&&dcritForm?h('div',{className:'fl-iedit'},
              ...dcritForm.map((c,i)=>h('div',{className:'fl-row',key:i},
                h('textarea',{value:c,disabled:locked,rows:2,'aria-label':`${L('交付物标准','Deliverable criterion')} ${item.index+1}.${i+1}`,onChange:e=>{const next=dcritForm.slice();next[i]=e.target.value;setDcritForm(next);},style:{flex:'1 1 auto',minWidth:0}}),
                button('×',()=>setDcritForm(dcritForm.filter((_,x)=>x!==i)),{disabled:locked,'aria-label':L('删除这条标准','Remove this criterion')}))),
              h('button',{type:'button',className:'fl-linkbtn',disabled:locked,onClick:()=>setDcritForm([...dcritForm,''])},'＋ '+L('新增一条标准','Add a criterion')),ibar())
              :crits.length?h('ol',{className:'fl-critlist'},...crits.map((c,i)=>h('li',{key:i},c))):h('p',{className:'fl-help'},L('尚无这项交付物的标准','No criteria for this deliverable yet')),
            view.title&&view.spec&&h('details',{'data-fleet-draft-deliverable-spec':item.index},h('summary',null,L('Agent 完整规格','Full agent spec')),h('pre',{className:'fl-mono fl-small'},view.spec)),
            item.latest?h(React.Fragment,null,
              h('p',{className:'fl-small fl-muted'},`v${item.latest.version} · ${shortHash(item.latest.sha256)} · ${timestamp(item.latest.submittedAt,L)}`),
              fileLink(o,snapshotTarget(o,item.latest.snapshotPath),L('查看位置 ↗','Open location ↗'),{'data-fleet-draft-deliverable-link':item.index}))
              :h('p',{className:'fl-help'},L('尚未提交产物','No artifact submitted yet')),
            item.delivery&&h('p',{className:'fl-small'},`${L('已交付','Delivered')} ${timestamp(item.delivery.deliveredAt,L)}`));}))
            :h('p',{className:'fl-help'},L('尚未指定交付物','No deliverables specified')),
          h('div',{className:'fl-dk'},L('整单验收标准','Ticket-wide acceptance criteria')),
          editing==='crit'
            ?h('div',{className:'fl-iedit'},
              ...list(editCrits).map((c,i)=>h('div',{className:'fl-row',key:i},
                h('textarea',{name:'criteria',value:c,disabled:locked,rows:2,'aria-label':`${L('整单验收标准','Ticket-wide criterion')} ${i+1}`,onChange:e=>{const next=list(editCrits).slice();next[i]=e.target.value;setCrits(next);},style:{flex:'1 1 auto',minWidth:0}}),
                button('×',()=>setCrits(list(editCrits).filter((_,x)=>x!==i)),{disabled:locked,'aria-label':L('删除这条标准','Remove this criterion')}))),
              h('button',{type:'button',className:'fl-linkbtn',disabled:locked,onClick:()=>setCrits([...list(editCrits),''])},'＋ '+L('新增一条标准','Add a criterion')),
              ibar())
            :h('button',{type:'button',className:'fl-eblock',disabled:locked,onClick:()=>openEdit('crit')},
              criteria.length?h('ol',{className:'fl-critlist'},...criteria.map((c,i)=>h('li',{key:i},c))):h('p',{className:'fl-help'},L('尚无整单标准 · 跨交付物的治理与总体要求写在这里','No ticket-wide criteria yet — cross-deliverable governance and overall requirements go here')))),
        (Object.keys(viewPlan.inputs||{}).length>0||viewPlan.requirements!==undefined||editable)&&h('div',{className:'fl-dcard'},
          h('div',{className:'fl-dsec'},L('任务输入','Inputs')),
          h('div',{className:'fl-row fl-between'},h('span',{className:'fl-small fl-muted'},L('交付目录','Delivery target')),editable&&button(editing==='target'?'✕':'✎',()=>editing==='target'?cancelEdit():openEdit('target'),{className:'fl-btn fl-btn-ghost','aria-label':L('编辑交付目录','Edit delivery target'),'data-fleet-target-edit':''})),
          editing==='target'?h('div',{className:'fl-iedit'},h('input',{className:'fl-input',value:targetForm??'',disabled:locked,placeholder:L('缺省：Ticket 交付区','Default: Ticket delivery area'),onChange:e=>setTargetForm(e.target.value),'data-fleet-target-input':''}),ibar())
            :h('p',{className:'fl-small'},viewPlan.inputs?.deliveryTarget||L('缺省：Ticket 交付区','Default: Ticket delivery area')),
          Object.keys(viewPlan.inputs||{}).length>0&&readValue(viewPlan.inputs),
          viewPlan.requirements!==undefined&&h(React.Fragment,null,h('div',{className:'fl-dsec'},L('补充要求','Requirements')),h('p',{className:'fl-message'},viewPlan.requirements))),
        h('div',{className:'fl-dcard'},
          h('div',{className:'fl-dsec'},L('怎样推进','How it proceeds')),
          row(badge(`${nodes.length} ${L('节点','nodes')}`),badge(`${gates.length} ${L('关卡','gates')}`)),
          nodes.length?h('div',{className:'fl-gflow'},
            ...levels.flatMap((level,i)=>[i>0?h('div',{className:'fl-glink',key:`link-${i}`}):null,
              level.length>1?h('div',{className:'fl-ggroup',key:`group-${i}`},h('span',{className:'fl-gtab'},`${L('并行','Parallel')} · ${level.length}`),...level.map(nodeCard)):nodeCard(level[0]),
              ...gates.filter(gate=>{const froms=list(gate.from).map(id=>levels.findIndex(group=>group.some(node=>node.id===id)));return froms.length&&froms.every(l=>l>=0)&&Math.max(...froms)===i;}).flatMap(gate=>[h('div',{className:'fl-glink',key:`gate-link-${gate.id}`}),gateCard(gate)])]))
            :h('p',{className:'fl-help'},L('尚未配置节点','No nodes configured yet'))),
        (editable||planHasSeries(viewPlan)||viewPlan.ticketDependencies?.length||viewPlan.logicGates?.length||nodes.some(n=>n.ticketDependencies?.length)||deliverables.some(d=>d?.whenNodeRuns))&&h('details',{className:'fl-dcard','data-fleet-routing-editor':''},
           h('summary',null,L('上游依赖与条件路线','Upstream dependencies and conditional routes')),
           routingEditor({L,data:o.data,plan:viewPlan,ticketId:base.id,form:values.routing||routingFields(viewPlan),onChange:form=>change('routing',form),locked})),
         conflict&&h('p',{className:'fl-notice',role:'alert'},L('草稿已有更新。你的输入已保留，请复制需要的内容后重新加载最新版本再修改。','The draft has changed. Your input is preserved. Copy any changes you need, then reload the latest version before editing.')),
        (error||o.error)&&h('p',{className:'fl-notice',role:'alert'},error||o.error),
        note&&h('p',{className:'fl-notice',role:'status'},note),
        h('p',{className:'fl-help'},L('应用或保存即你的确认。保存后可在下方「启动」就地定稿运行，也可在任务页或 /fleet start 启动。','Apply or Save is your confirmation. Once saved, start the run right below; the Ticket page and /fleet start work too.')),
        startable&&startPhase==='confirm'?h('div',{className:'fl-notice','data-fleet-start-confirm':''},
          h('p',null,incoming.status==='draft'?L('启动将冻结当前配置快照并派发未完成节点。','Starting freezes the current configuration snapshot and dispatches pending nodes.'):L('恢复将按最新配置继续未完成节点，已完成部分保持。','Resuming continues pending nodes with the latest configuration; completed work is preserved.')),
          h('p',{className:'fl-small fl-muted'},String(values.goal||'').slice(0,120)),
          h('div',{className:'fl-row'},button(incoming.status==='draft'?L('确认启动','Confirm and start'):L('确认恢复','Confirm and resume'),()=>{setStartPhase(null);void o.onStart?.();},{className:'fl-btn fl-btn-primary',disabled:locked||saving||o.busy,'data-fleet-start-submit':''}),button(L('取消','Cancel'),()=>setStartPhase(null),{className:'fl-btn fl-btn-ghost'}))):null,
        startable&&!startCheck.valid&&startPhase===null?h('p',{className:'fl-help','role':'status','data-fleet-start-diagnostics':''},L('启动校验未通过：','Start validation pending: '),...startCheck.errors.slice(0,3).map((e,i)=>h('span',{key:i,className:'fl-small fl-muted'},`${i?' · ':''}${e.path}: ${e.message}${startCheck.errors.length>3&&i===2?L(` 等 ${startCheck.errors.length} 项`,` and ${startCheck.errors.length} more`):''}`))):null,
        startable&&needsSeriesSchedule(incoming,viewPlan,o.data)&&h('p',{className:'fl-help'},seriesStartHint(L)),
         startable&&scheduleUnavailable&&h('p',{role:'status',className:'fl-help','data-fleet-schedule-unavailable':''},scheduleUnavailable),
        scopeChoice&&h(ScopePicker,{L,choices:scopeChoice.choices,busy:saving||o.busy,onChoose:chooseScope}),
        scheduleOpen&&h('div',{className:'fl-dcard','data-fleet-draft-schedule-panel':''},
          h('div',{className:'fl-dsec'},L('安排执行','Schedule runs')),
          h(ScheduleForm,{L,initialName:titleText||base.id,busy:o.busy,error:o.error,unavailable:scheduleUnavailable,summary:planFreezeSummary(viewPlan,L),onCancel:()=>setScheduleOpen(false),onSubmit:async args=>(await o.onSchedule?.(args))??null})),
        h('div',{className:'fl-dfoot'},
          h('span',{className:'fl-small fl-muted','data-fleet-draft-state':saving?'saving':dirty?'dirty':'saved'},saving?L('正在保存…','Saving…'):dirty?L('有未保存修改','Unsaved changes'):L('已保存','Saved')),
          h('span',{className:'fl-row',style:{marginLeft:'auto'}},
            button(saving?L('正在保存…','Saving…'):dirty?L('保存修改','Save changes'):L('已保存','Saved'),()=>void save(),{disabled:locked||saving,'data-fleet-draft-save':''}),
            startable&&button(incoming.status==='draft'?L('启动','Start'):L('恢复运行','Resume'),()=>setStartPhase('confirm'),{className:'fl-btn fl-btn-primary',disabled:locked||saving||o.busy||dirty||!startCheck.valid||needsSeriesSchedule(incoming,viewPlan,o.data)||incoming.dependencyReadiness?.ready===false,'data-fleet-draft-start':'',title:dirty?L('请先保存','Save first'):startCheck.valid?'':startCheck.errors.map(e=>`${e.path}: ${e.message}`).join(' ')}),
            startable&&typeof o.onSchedule==='function'&&button(L('安排执行','Schedule'),()=>setScheduleOpen(value=>!value),{disabled:locked||saving||o.busy||dirty||!startCheck.valid||!!scheduleUnavailable,'data-fleet-draft-schedule':'',title:dirty?L('请先保存','Save first'):scheduleUnavailable||(startCheck.valid?L('按固定钟点一次性或周期执行','Run once or recurring at a fixed wall-clock time'):startCheck.errors.map(e=>`${e.path}: ${e.message}`).join(' '))}),
            button(L('重新加载','Reload'),()=>{detailEdits.current.clear();accept(incoming);setError(null);setNote(null);o.onReload();},{disabled:locked||saving})))),
      popReady&&h('div',{className:'fl-popbackdrop','aria-hidden':true,style:{left:popRect.left,top:popRect.top,width:popRect.width,height:popRect.height}}),
      popCard);
  }
  function legacyPlan(o) {
    const L=language(o),ticket=o.draft,validation=validatePlan(ticket.plan,{mode:'save'}),goal=ticket.plan?.goal??ticket.plan?.ticket?.goal??ticket.goal;
    if(isIncompatibleDraft(ticket))return incompatibleDraftNotice(ticket,o);
    const replacement=list(o.data?.tickets||o.tickets).find(item=>item.id===ticket.supersededBy);
    const hasOrigin=typeof ticket.originSessionId==='string'&&!!ticket.originSessionId.trim(),canRecover=['draft','stopped'].includes(ticket.status)&&!o.readOnly;
    const recoveryCommand=`/fleet ${ticket.status==='draft'?'regenerate':'repair'} ${ticket.id} ${ticket.revision}`;
    return h('section',{className:'fl-card fl-card-pad','data-fleet-legacy-ticket':ticket.id},row(h('h2',null,L('计划需要兼容处理','Plan needs compatibility repair')),status(ticket.status,L)),
      h('p',{className:'fl-spaced'},ticket.plan?.goal||ticket.plan?.ticket?.goal||ticket.goal||ticket.id),
      h('p',{className:'fl-notice',role:'status'},L('此计划使用旧版、未知版本或不受支持的格式，无法在当前编辑器中安全保存。','This plan uses an old, unknown or unsupported format and cannot safely be saved in this editor.')),
      h('ul',null,...list(validation.errors).map((issue,i)=>h('li',{key:i},`${issue.path||'plan'}: ${issue.message}`))),
      o.error&&h('p',{className:'fl-notice',role:'alert'},o.error),
      (typeof goal!=='string'||!goal.trim())&&h('p',{className:'fl-help'},hasOrigin?L('原始记录没有可恢复的任务目标。请回到原始对话提供目标后再恢复。','The original record has no recoverable goal. Provide the goal in the original conversation before recovery.'):L('原始记录没有可恢复的任务目标。请在该工作区的对话中提供明确目标后再恢复。','The original record has no recoverable goal. Provide an explicit goal in a conversation in this Workspace before recovery.')),
      canRecover&&hasOrigin&&row(o.onRepair&&button(L('尝试无损修复','Try lossless repair'),()=>o.onRepair(ticket),{disabled:o.busy}),ticket.status==='draft'&&o.onRegenerate&&button(L('重新生成新任务','Regenerate as new Ticket'),()=>o.onRegenerate(ticket),{disabled:o.busy})),
      canRecover&&!hasOrigin&&h('p',{className:'fl-help','data-fleet-legacy-session-help':''},L('此历史任务没有关联的来源对话。请在该工作区的对话中使用 ','This historical Ticket has no linked source conversation. In a conversation in this Workspace, use '),h('code',null,recoveryCommand),ticket.status==='draft'?L(' 创建替代草稿。',' to create a replacement draft.'):L(' 明确修复此任务。',' to explicitly repair this Ticket.')),
      ticket.replacementDeleted&&h('p',{className:'fl-help','data-fleet-replacement-deleted':ticket.id},L('替代草稿已删除','Replacement draft was deleted')),
      ticket.supersededBy&&o.onOpenTicket&&(replacement?ticketLink(replacement,o,{label:L('打开替代任务','Open replacement Ticket'),onOpen:()=>o.onOpenTicket(replacement.id),className:'fl-btn'}):button(L('打开替代任务','Open replacement Ticket'),()=>o.onOpenTicket(ticket.supersededBy))),
      h('p',{className:'fl-help fl-spaced'},L('修复会保留原始记录；重新生成仅在新任务保存成功后替代此草稿。','Repair retains the original record; regeneration replaces this draft only after the new Ticket is saved.')));
  }
  const renderDraftEditor=options=>isIncompatibleDraft(options.draft)?incompatibleDraftNotice(options.draft,options):validatePlan(options.draft.plan,{mode:'save'}).valid?h(DraftEditor,{key:options.draft.id,...options}):legacyPlan(options);
  // P-69 Root overview: cross-Workspace browsing only. Ticket details and every
  // write stay in the owning Workspace surface and its single service path.
  const hiddenReason = ticket => ticket.abandonedAt ? 'abandoned' : ticket.status === 'delivered' ? 'done' : null;
  const attentionOf = ticket => {
    if (hiddenReason(ticket)) return null;
    if (list(ticket.nodes).some(node => node.status === 'failed')) return {sec:'now', key:['执行失败','Failed'], tone:'danger', rank:0};
    if (list(ticket.nodes).some(node => node.status === 'interrupted')) return {sec:'now', key:['待核对','Needs check'], tone:'danger', rank:1};
    if (list(ticket.gates).some(gate => gate.status === 'returned' || gate.coverage === 'stale')) return {sec:'now', key:['审核待处理','Review needs attention'], tone:'danger', rank:2};
    if (waiting(ticket).some(gate => gate.reviewer?.kind === 'human')) return {sec:'now', key:['待人工审核','Awaiting review'], tone:'waiting', rank:3};
    if (ticket.status === 'running') return {sec:'running', key:['执行中','Running'], tone:'running', rank:3};
    if (ticket.status === 'draft' && !ticket.incompatible) return {sec:'draft', key:['草稿待启动','Draft not started'], tone:'neutral', rank:4};
    return null;
  };
  function RootOverview(o) {
    const {projects, series, pending, error, mode, notice} = o, L = language(o);
    const tab = o.ui?.tab ?? 'attention', showHidden = !!o.ui?.showHidden;
    const setTab = value => o.setUI({ tab: value });
    const setShowHidden = update => o.setUI({ showHidden: typeof update === 'function' ? update(showHidden) : update });
    const tickets = list(projects).flatMap(project => list(project.tickets).map(ticket => ({ ...ticket, project })));
    const row = ticket => {
      const context = attentionOf(ticket), title = ticketTitle(ticket), workspace = ticket.project.title || ticket.project.workspaceId;
      const label = ticket.abandonedAt ? L('已放弃执行','Abandoned') : ticket.incompatible ? L('旧版草稿','Legacy draft') : context ? L(...context.key) : names[ticket.status] ? L(...names[ticket.status]) : ticket.status;
      const tone = ticket.abandonedAt ? 'neutral' : ticket.incompatible ? 'waiting' : context?.tone || tones[ticket.status];
      return h('button',{key:ticket.project.workspaceId + ':' + ticket.id,type:'button',className:'fl-grow fl-root-ticket',
        'data-fleet-root-ticket':ticket.id,'data-fleet-root-workspace':ticket.project.workspaceId,
        onClick:() => o.openTicket(ticket.project.workspaceId,ticket.id)},
        h('span',{className:'fl-st','data-tone':tone},h('i',{className:'fl-dot','aria-hidden':true}),label),
        h('span',{className:'fl-id',title:ticket.id},ticket.id),
        h('span',{className:'fl-ttl',title},h('strong',null,title)),
        h('span',{className:'fl-root-workspace fl-small fl-muted',title:workspace},workspace),
        pips(list(ticket.nodes).slice(0,4)),
        h('span',{className:'fl-small fl-muted fl-upd'},timestamp(ticket.updatedAt,L)));
    };
    const section = (titleKey, rows, tone) => rows.length ? h('section',{className:'fl-root-group'},
      h('h3',{className:'fl-ghead'},h('i',{className:'fl-dot','data-tone':tone,'aria-hidden':true}),L(...titleKey),h('span',{className:'fl-count'},rows.length)),
      ...rows.map(row)) : null;
    const unreadable = list(projects).filter(project => project.state === 'error');
    const readError = project => h('div',{className:'fl-notice fl-row fl-between',key:project.workspaceId,role:'alert'},
      h('span',null,project.title || project.workspaceId,' · ',L('暂时无法读取','Temporarily unreadable')),
      button(L('重试','Retry'),() => o.refresh(),{className:'fl-btn fl-btn-sm',disabled:pending}));
    const attention = () => {
      const by = sec => tickets.filter(ticket => attentionOf(ticket)?.sec === sec).sort((a,b) => attentionOf(a).rank - attentionOf(b).rank);
      const now = by('now'), running = by('running'), draft = by('draft');
      const hidden = tickets.filter(hiddenReason);
      const doneCount = hidden.filter(ticket => hiddenReason(ticket) === 'done').length, abandonedCount = hidden.length - doneCount;
      const empty = !now.length && !running.length && !draft.length;
      const nowAt = Date.now();
      const upcoming = list(series).flatMap(item => projectSeries(item,nowAt,nowAt + 86400000)).filter(event => event.state === 'upcoming').length;
      return h(React.Fragment,null,
        h('div',{className:'fl-metrics fl-strip'},
          metric(L('需要现在处理','Needs action now'),now.length,L('审核、失败或待核对','Review, failure or needs check')),
          metric(L('执行中','Running'),running.length,L('正在执行的 Ticket','Tickets in progress')),
          metric(L('计划执行','Scheduled runs'),upcoming,L('未来 24 小时','Next 24 hours')),
          metric(L('已隐藏','Hidden'),hidden.length,L('已完成或已放弃执行','Done or abandoned'))),
        h('h2',{className:'fl-root-section-title'},L('跨工作区任务','Tickets across workspaces')),
        !empty && h('div',{className:'fl-glist'},
          section(['需要现在处理','Needs action now'],now,'danger'),
          section(['执行中','Running'],running,'running'),
          section(['待确认的草稿','Drafts to confirm'],draft,'neutral')),
        empty && !unreadable.length && h('div',{className:'fl-card fl-empty'},h('h2',null,L('没有需要你处理的事项','Nothing needs your attention'))),
        ...unreadable.map(readError),
        h('div',{className:'fl-hidden-bar','data-fleet-hidden-bar':''},
          h('div',{className:'fl-row'},h('strong',null,L('已隐藏','Hidden'),' ',hidden.length),badge(L('已完成','Done') + ' ' + doneCount,'success'),badge(L('已放弃执行','Abandoned') + ' ' + abandonedCount,'neutral')),
          button(showHidden ? L('收起已隐藏','Hide hidden') : L('显示已隐藏','Show hidden'),() => setShowHidden(value => !value),{className:'fl-btn fl-btn-sm','data-fleet-show-hidden':''})),
        showHidden && hidden.length ? h('section',{className:'fl-glist fl-spaced'},...hidden.map(row)) : null);
    };
    const all = () => list(projects).map(project => h('section',{key:project.workspaceId,className:'fl-glist fl-project'},
      h('div',{className:'fl-ghead'},h('h2',null,project.title || project.workspaceId),
        project.state === 'ok' && h('span',{className:'fl-count'},list(project.tickets).length)),
      project.state === 'error' ? readError(project)
        : list(project.tickets).length ? list(project.tickets).map(ticket => row({...ticket,project}))
        : h('div',{className:'fl-empty'},h('p',null,L('该工作区暂无 Ticket','No tickets in this workspace')))));
    const isOn = id => mode.enabledWorkspaceIds.includes(id);
    const entries = list(o.workspaces).length ? list(o.workspaces) : list(projects);
    const settings = () => h(React.Fragment,null,
      h('div',{className:'fl-section-title'},h('h2',null,L('已登记工作区','Registered workspaces')),
        h('p',{'data-fleet-registered-count':entries.length},L(`${entries.filter(workspace => isOn(workspace.workspaceId)).length} / ${entries.length} 已开启 Fleet`,`${entries.filter(workspace => isOn(workspace.workspaceId)).length} / ${entries.length} enabled`))),
      h('section',{className:'fl-card','data-fleet-project-bar':''},...entries.map(workspace => {
        const id = workspace.workspaceId, on = isOn(id), title = workspace.title || workspace.path || id;
        return h('article',{key:id,className:'fl-root-settings-row','data-fleet-control-row':id},
          h('div',{className:'fl-control-info'},h('h3',{'data-fleet-control-title':''},title),h('p',{className:'fl-mono fl-muted'},workspace.path || '')),
          h('div',null,badge(mode.ready ? (on ? L('Fleet 已开启','Fleet on') : L('Fleet 已关闭','Fleet off')) : L('读取中…','Loading…'),on ? 'success' : 'neutral')),
          h('div',{className:'fl-row fl-root-settings-actions'},
            on && button(L('进入工作区','Open workspace'),() => o.openWorkspace(id),{className:'fl-btn fl-btn-sm','data-fleet-open':id}),
            button(on ? L('关闭','Disable') : L('开启','Enable'),() => o.toggleWorkspace(id,!on),{className:'fl-btn fl-btn-sm','data-fleet-toggle':id,'aria-pressed':on,disabled:!mode.ready || mode.pending}))); 
      })));
    const tabs = [['attention',L('需要关注','Needs attention')],['schedule',L('计划','Schedules')],['all',L('全部 Tickets','All tickets')]];
    const admin = o.admin && Array.isArray(o.admin.workspaces) ? o.admin.workspaces : null;
    if (admin?.length) tabs.push(['admin',L('Admin','Admin')]);
    const settingsTab = ['settings',L('工作区配置','Workspace settings')];
    const adminView = () => {
      const scope = new Set(admin.flatMap(entry => entry.scope === 'all' ? list(projects).map(project => project.workspaceId) : list(entry.scope)));
      const feed = tickets.filter(ticket => scope.has(ticket.project.workspaceId)).sort((a,b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0,25);
      return h(React.Fragment,null,
        h('div',{className:'fl-metrics fl-strip'},
          metric(L('Admin 工作区','Admin workspaces'),admin.length,L('被授予管理面的工作区','Workspaces granted the Admin surface')),
          metric(L('可管理任务','Managed tickets'),feed.length,L('范围内的 Ticket（最近更新）','Tickets in scope, most recent'))),
        h('div',{className:'fl-section-title'},h('h2',null,L('授权范围','Granted scope')),
          h('p',null,L('由工作区在自身配置中开启；活动仅供参考，写入走 Admin Command 或 Command Tools。','Enabled by each Workspace in its own configuration; this feed is read-only.'))),
        h('section',{className:'fl-card','data-fleet-admin-grants':''},...admin.map(entry => h('div',{key:entry.workspaceId,className:'fl-root-settings-row','data-fleet-admin-grant':entry.workspaceId},
          h('div',{className:'fl-control-info'},h('h3',null,entry.workspaceId),h('p',{className:'fl-small fl-muted'},entry.scope === 'all' ? L('管理全部工作区','All workspaces') : L(`管理：${list(entry.scope).join(' · ')}`,'Managed: ' + list(entry.scope).join(' · ')))),
          h('div',null,badge(entry.scope === 'all' ? L('全部','All') : L('范围','Scoped'),'waiting'))))),
        h('div',{className:'fl-section-title'},h('h2',null,L('Admin Feed','Admin feed')),h('p',null,L('范围内最近更新的 Ticket','Recently updated Tickets in scope'))),
        feed.length ? h('section',{className:'fl-glist','data-fleet-admin-feed':''},...feed.map(row)) : h('div',{className:'fl-card fl-empty'},h('p',null,L('范围内暂无 Ticket','No tickets in scope'))));
    };
    const current = [...tabs,settingsTab].find(([key]) => key === tab);
    const navButton = ([key,label]) => button(label,() => setTab(key),{key,className:'fl-btn fl-btn-ghost','data-fleet-root-tab':key,'aria-current':tab === key ? 'page' : undefined});
    return h('div',{className:'fl-content'},
      h('div',{className:'fl-crumb'},h('div',{className:'fl-row'},h('strong',null,'oh-my-dsh-fleet'),o.pluginVersion&&badge(`v${o.pluginVersion}`)),
        h('div',{className:'fl-row fl-crumb-actions'},languageSelect(o),button(L('返回会话','Back to chat'),o.returnToConversation,{className:'fl-btn fl-btn-ghost'}))),
      h('nav',{className:'fl-overview-nav','aria-label':L('Fleet 总览导航','Fleet overview navigation')},
        h('div',{className:'fl-overview-nav-group'},...tabs.map(navButton)),navButton(settingsTab)),
      h('header',{className:'fl-head'},h('div',null,h('h1',{id:'fleet-control-title'},tab === 'attention' ? L('Fleet 总览','Fleet overview') : current?.[1]),
        h('p',null,tab === 'settings' ? L('按工作区开启或关闭 DSH Fleet。','Enable or disable DSH Fleet by workspace.') : tab === 'admin' ? L('被授予的 Admin 范围与跨工作区动态。','Granted Admin scope and cross-workspace activity.') : L('汇总已登记工作区的 Ticket 和计划。','Tickets and schedules across registered workspaces.'))),
        button(pending ? L('读取中…','Loading…') : L('刷新','Refresh'),() => o.refresh(),{className:'fl-btn',disabled:pending})),
      error && h('div',{className:'fl-notice',role:'alert'},h('p',null,error),button(L('重试','Retry'),() => o.refresh(),{className:'fl-btn fl-btn-sm'})),
      notice && h('p',{className:'fl-notice',role:'status'},notice),
      tab === 'settings' ? settings() :
      tab === 'admin' ? adminView() :
      pending && !list(projects).length ? h('p',{className:'fl-loading',role:'status'},L('正在读取…','Loading…')) :
      tab === 'attention' ? attention() : tab === 'schedule'
        ? h(ScheduleCalendar,{L,items:list(series),act:o.actSeries,busy:false,
            navigate:(page,patch,item) => page === 'ticket' ? o.openTicket(item.workspaceId,patch.ticketId) : null,
            openDialog:o.openSeries,workspaceBlocked:id=>!isOn(id),
            unavailable:o.scheduleStatus?.available === false ? (o.scheduleStatus.unavailableReason || L('宿主定时服务不可用。','Host schedule service is unavailable.')) : null})
        : all());
  }
  return {renderDashboard,renderControl,renderDraftEditor,renderRootOverview:RootOverview};
}
