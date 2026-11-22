// The native Workspace owns its provider, tree rows and sessions. This adapter
// owns only supplementary navigation nodes inside an already-mounted sidebar.
const workspaceNavigationMounts = new WeakMap();

/**
 * Add a removable Dashboard button below each expanded, enabled Workspace.
 * root: the mounted sidebar column (never document/body or the Chat surface).
 * getState(): {workspaces: [{workspaceId, label}], enabledWorkspaceIds, activeWorkspaceId}.
 * subscribe(notify): subscribe to workspace/mode/panel changes and return cleanup.
 * onOpen(workspaceId): select the independent Dashboard; do not open a Session.
 * Returns an idempotent disposer. Multiple icons in one sidebar share one mount.
 * Native DOM contract: rc.5 workspace treeitem + --dsh-workspace-indent section.
 * Missing anchors fail closed; search/flat/archived views remain native-owned.
 */
export function mountWorkspaceDashboardLinks({root, getState, subscribe, onOpen, label = 'Dashboard'}) {
  if (!root?.ownerDocument?.defaultView || root === root.ownerDocument.body || root === root.ownerDocument.documentElement) {
    throw new TypeError('Workspace navigation requires a mounted sidebar element.');
  }
  let mount = workspaceNavigationMounts.get(root);
  if (!mount) {
    const doc = root.ownerDocument;
    const win = doc.defaultView;
    const rows = new Map();
    let stopped = false;
    let scheduled = false;
    let unsubscribe;
    const style = doc.createElement('style');
    style.dataset.fleetWorkspaceNavStyle = '';
    style.textContent = `
.dsh-fleet-workspace-nav{box-sizing:border-box;width:100%;padding:1px 4px 3px calc(28px + var(--dsh-workspace-indent,0px))}
.dsh-fleet-workspace-nav__button{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-height:30px;padding:5px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.dsh-fleet-workspace-nav__button:hover,.dsh-fleet-workspace-nav__button[aria-current="page"]{background:var(--dsw-alias-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,inherit)}
.dsh-fleet-workspace-nav__button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4676ef);outline-offset:-2px}
.dsh-fleet-workspace-nav__label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;
    doc.head.append(style);

    const observe = () => observer.observe(root, {childList:true, subtree:true, attributes:true,
      attributeFilter:['aria-expanded','data-row-key','style','inert','aria-hidden']});
    const set = (element, name, value) => {
      if (element.getAttribute(name) !== value) element.setAttribute(name, value);
    };
    const schedule = () => {
      if (stopped || scheduled) return;
      scheduled = true;
      win.queueMicrotask(() => {
        scheduled = false;
        if (!stopped) refresh();
      });
    };
    const observer = new win.MutationObserver(schedule);
    const refresh = () => {
      observer.disconnect();
      try {
        const state = getState();
        const workspaces = new Map((state.workspaces ?? []).map(workspace => [workspace.workspaceId, workspace]));
        const enabled = new Set(state.enabledWorkspaceIds ?? []);
        const retained = new Set();
        for (const header of root.querySelectorAll('[role="treeitem"][data-row-key^="workspace:"]')) {
          const workspaceId = header.getAttribute('data-row-key').slice('workspace:'.length);
          const workspace = workspaces.get(workspaceId);
          const tree = header.closest('[role="tree"]');
          if (!workspace || !enabled.has(workspaceId) || !tree || !root.contains(tree) ||
              header.getAttribute('aria-expanded') !== 'true' || header.closest('[inert],[aria-hidden="true"]')) continue;
          // The HoverCard may wrap the header. Insert after its direct child in
          // the group section, never into native title/actions/hover content.
          let section = header.parentElement;
          while (section && section !== tree && !section.style.getPropertyValue('--dsh-workspace-indent')) section = section.parentElement;
          if (!section || section === tree) continue;
          let anchor = header;
          while (anchor.parentElement !== section) anchor = anchor.parentElement;
          let row = rows.get(header);
          if (!row) {
            const host = doc.createElement('div');
            host.className = 'dsh-fleet-workspace-nav';
            host.dataset.fleetWorkspaceEntry = workspaceId;
            host.setAttribute('role', 'treeitem');
            // Deliberately no data-row-key: native AnimatedRows owns that set.
            const button = doc.createElement('button');
            button.type = 'button';
            button.className = 'dsh-fleet-workspace-nav__button';
            const icon = doc.createElement('span');
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = '▤';
            const text = doc.createElement('span');
            text.className = 'dsh-fleet-workspace-nav__label';
            text.textContent = label;
            button.append(icon, text);
            button.addEventListener('click', event => {
              event.stopPropagation();
              const latest = getState();
              if ((latest.enabledWorkspaceIds ?? []).includes(workspaceId) &&
                  (latest.workspaces ?? []).some(item => item.workspaceId === workspaceId)) onOpen(workspaceId);
            });
            host.append(button);
            row = {host, button};
            rows.set(header, row);
          }
          retained.add(header);
          const workspaceLabel = workspace.label || workspace.title || workspaceId;
          const accessibleLabel = `${state.dashboardLabel || 'oh-my-dsh-fleet Dashboard'} · ${workspaceLabel}`;
          if (state.language) set(row.host, 'lang', state.language === 'zh' ? 'zh-CN' : 'en');
          const depth = Math.max(0, Math.round(parseFloat(section.style.getPropertyValue('--dsh-workspace-indent')) / 12) || 0);
          set(row.host, 'aria-level', String(depth + 2));
          set(row.host, 'aria-selected', String(state.activeWorkspaceId === workspaceId));
          set(row.host, 'aria-label', accessibleLabel);
          set(row.button, 'aria-label', accessibleLabel);
          set(row.button, 'title', accessibleLabel);
          if (state.activeWorkspaceId === workspaceId) set(row.button, 'aria-current', 'page');
          else row.button.removeAttribute('aria-current');
          if (anchor.nextSibling !== row.host) section.insertBefore(row.host, anchor.nextSibling);
        }
        for (const [header, row] of rows) {
          if (retained.has(header)) continue;
          row.host.remove();
          rows.delete(header);
        }
      } finally {
        if (!stopped) observe();
      }
    };
    mount = {refs:0, dispose() {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
      unsubscribe?.();
      for (const row of rows.values()) row.host.remove();
      rows.clear();
      style.remove();
      workspaceNavigationMounts.delete(root);
    }};
    workspaceNavigationMounts.set(root, mount);
    try {
      refresh();
      unsubscribe = subscribe?.(schedule);
    } catch (error) {
      mount.dispose();
      throw error;
    }
  }
  mount.refs += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--mount.refs === 0) mount.dispose();
  };
}
