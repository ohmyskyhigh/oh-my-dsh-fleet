/** Scoped shadcn-style primitives. Theme colors follow the native DSH surface. */
export const fleetStyles = `
.dsh-fleet-shell {
  --fl-bg:var(--dsw-alias-bg-base,#fff); --fl-fg:var(--dsw-alias-label-primary,#0a0a0a);
  --fl-muted:var(--dsw-alias-label-secondary,#737373);
  --fl-running:color-mix(in srgb,#2563eb 65%,var(--fl-fg)); --fl-waiting:color-mix(in srgb,#ca8a04 65%,var(--fl-fg));
  --fl-danger:color-mix(in srgb,#dc2626 65%,var(--fl-fg)); --fl-success:color-mix(in srgb,#16a34a 65%,var(--fl-fg));
  --fl-subtle:color-mix(in srgb,var(--fl-fg) 4%,var(--fl-bg));
  --fl-border:color-mix(in srgb,var(--fl-fg) 13%,var(--fl-bg));
  --fl-ring:color-mix(in srgb,var(--fl-fg) 45%,var(--fl-bg));
  box-sizing:border-box;flex:1 1 auto;min-width:0;min-height:0;overflow:auto;
  padding:28px 32px 40px;padding-block-start:max(28px,var(--dsh-frame-top-clearance,0px));
  padding-inline-start:max(32px,var(--dsh-frame-leading-clearance,0px));
  color:var(--fl-fg);background:var(--fl-bg);font-size:14px;line-height:1.6;font-family:inherit;
  container: fleet / inline-size;accent-color:var(--fl-fg);
}
.dsh-fleet-shell *, .dsh-fleet-shell *::before, .dsh-fleet-shell *::after {box-sizing:border-box}
.dsh-fleet-shell .fl-content {width:100%;max-width:1440px;margin:auto;min-width:0}
.dsh-fleet-shell h1,.dsh-fleet-shell h2,.dsh-fleet-shell h3,.dsh-fleet-shell p {margin:0}
.dsh-fleet-shell h1 {font-size:28px;line-height:1.3;font-weight:650;letter-spacing:-.025em;overflow-wrap:anywhere}
.dsh-fleet-shell h2 {font-size:16px;line-height:1.5;font-weight:600}
.dsh-fleet-shell h3 {font-size:14px;line-height:1.5;font-weight:600}
.dsh-fleet-shell .fl-muted {color:var(--fl-muted)}
.dsh-fleet-shell .fl-small {font-size:12px}
.dsh-fleet-shell .fl-mono {font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;overflow-wrap:anywhere}
.dsh-fleet-shell .fl-row {display:flex;align-items:center;gap:10px;min-width:0;flex-wrap:wrap}
.dsh-fleet-shell .fl-between {justify-content:space-between}
.dsh-fleet-shell .fl-stack {display:grid;gap:16px;min-width:0}
.dsh-fleet-shell .fl-spaced {margin-top:24px}
.dsh-fleet-shell .fl-head {display:flex;justify-content:space-between;gap:20px;align-items:center;margin:26px 0;flex-wrap:wrap}
.dsh-fleet-shell .fl-head p {color:var(--fl-muted);margin-top:8px;max-width:72ch;overflow-wrap:anywhere}
.dsh-fleet-shell .fl-crumb {display:flex;justify-content:space-between;gap:12px;align-items:center;min-height:32px;font-size:12px;flex-wrap:wrap}
.dsh-fleet-shell .fl-crumb strong {font-weight:600}
.dsh-fleet-shell .fl-crumb-actions {justify-content:flex-end;margin-inline-start:auto;max-width:100%}
.dsh-fleet-shell .fl-crumb [data-fleet-workspace-title] {overflow-wrap:anywhere;min-width:0}
.dsh-fleet-shell .fl-language {display:inline-flex;align-items:center;gap:8px;flex:0 0 auto;max-width:100%;font-size:12px;color:var(--fl-muted)}
.dsh-fleet-shell .fl-language span {white-space:nowrap}
.dsh-fleet-shell .fl-language select {width:auto;min-height:32px;padding:5px 9px;font-size:12px;line-height:20px;cursor:pointer}
.dsh-fleet-shell .fl-tabs {display:flex;gap:4px;overflow-x:auto;margin:22px 0 0;padding:6px 0 14px;border-bottom:1px solid var(--fl-border)}
.dsh-fleet-shell .fl-tabs button {white-space:nowrap;flex-shrink:0}
/* P-69 Root overview */
.dsh-fleet-shell .fl-tab {display:inline-flex;align-items:center;gap:8px;border:0;border-radius:0;background:none;color:var(--fl-muted);font:inherit;font-size:13px;font-weight:500;padding:10px 14px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.dsh-fleet-shell .fl-tab:hover {color:var(--fl-fg)}
.dsh-fleet-shell .fl-tab[aria-selected=true] {color:var(--fl-fg);border-bottom-color:var(--fl-fg)}
.dsh-fleet-shell .fl-section-title {display:flex;align-items:center;gap:10px;margin:26px 0 10px}
.dsh-fleet-shell .fl-ws-chip {display:inline-flex;align-items:center;font-size:11.5px;color:var(--fl-muted);padding:1px 8px;border:1px solid var(--fl-border);border-radius:6px;white-space:nowrap}
.dsh-fleet-shell .fl-hidden-bar {display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:22px;padding:12px 16px;border:1px dashed var(--fl-border);border-radius:10px;font-size:12.5px;color:var(--fl-muted)}
.dsh-fleet-shell .fl-project {margin-top:20px}
.dsh-fleet-shell .fl-project-head {padding:14px 20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;border-bottom:1px solid var(--fl-border)}
.dsh-fleet-shell .fl-project-info {min-width:160px;flex:1}
.dsh-fleet-shell .fl-project-info p {font-size:12px;color:var(--fl-muted);margin-top:2px;overflow-wrap:anywhere}
.dsh-fleet-shell .fl-ticket-row {display:flex;align-items:center;gap:14px;padding:13px 20px;border-bottom:1px solid var(--fl-border);min-width:0;flex-wrap:wrap;cursor:pointer}
.dsh-fleet-shell .fl-ticket-row:last-child {border-bottom:0}
.dsh-fleet-shell .fl-ticket-row:hover {background:var(--fl-subtle)}
.dsh-fleet-shell .fl-ticket-main {flex:1 1 260px;min-width:0}
.dsh-fleet-shell .fl-ticket-main p {font-size:12px;color:var(--fl-muted);margin-top:2px;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.dsh-fleet-shell .fl-ticket-meta {display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:0 0 auto}
.dsh-fleet-shell .fl-btn {display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:36px;padding:7px 12px;border:1px solid var(--fl-border);border-radius:8px;background:var(--fl-bg);color:var(--fl-fg);font:inherit;font-size:13px;font-weight:500;line-height:20px;text-decoration:none;cursor:pointer;box-shadow:0 1px 2px #00000006;max-width:100%;text-align:center}
.dsh-fleet-shell .fl-btn:hover {background:var(--fl-subtle)}
.dsh-fleet-shell .fl-btn-primary {background:var(--fl-fg);color:var(--fl-bg);border-color:var(--fl-fg)}
.dsh-fleet-shell .fl-btn-primary:hover {opacity:.88;background:var(--fl-fg)}
.dsh-fleet-shell .fl-btn-ghost {border-color:transparent;background:transparent;box-shadow:none}
.dsh-fleet-shell .fl-btn-sm {min-height:24px;padding:2px 9px;font-size:11.5px;color:var(--fl-muted)}
.dsh-fleet-shell .fl-btn-sm:hover {color:var(--fl-fg)}
.dsh-fleet-shell .fl-btn[aria-selected=true],.dsh-fleet-shell .fl-btn[aria-pressed=true] {background:var(--fl-subtle)}
.dsh-fleet-shell .fl-btn-danger {color:color-mix(in srgb,#dc2626 65%,var(--fl-fg));border-color:color-mix(in srgb,#ef4444 30%,var(--fl-border))}
.dsh-fleet-shell button:disabled {opacity:.45;cursor:default}
.dsh-fleet-shell :is(button,input,select,textarea,summary):focus-visible {outline:2px solid var(--fl-ring);outline-offset:3px}
.dsh-fleet-shell .fl-badge {display:inline-flex;gap:6px;align-items:center;white-space:nowrap;max-width:100%;padding:2px 8px;font-size:11px;font-weight:500;line-height:19px;border:1px solid var(--fl-border);border-radius:999px;background:var(--fl-subtle)}
.dsh-fleet-shell .fl-badge[data-tone=running] {color:color-mix(in srgb,#2563eb 65%,var(--fl-fg));background:color-mix(in srgb,#2563eb 9%,var(--fl-bg));border-color:transparent}
.dsh-fleet-shell .fl-badge[data-tone=waiting] {color:color-mix(in srgb,#ca8a04 65%,var(--fl-fg));background:color-mix(in srgb,#ca8a04 10%,var(--fl-bg));border-color:transparent}
.dsh-fleet-shell .fl-badge[data-tone=danger] {color:color-mix(in srgb,#dc2626 65%,var(--fl-fg));background:color-mix(in srgb,#dc2626 9%,var(--fl-bg));border-color:transparent}
.dsh-fleet-shell .fl-badge[data-tone=success] {color:color-mix(in srgb,#16a34a 65%,var(--fl-fg));background:color-mix(in srgb,#16a34a 9%,var(--fl-bg));border-color:transparent}
.dsh-fleet-shell .fl-card {border:1px solid var(--fl-border);border-radius:12px;background:var(--fl-bg);min-width:0;overflow:hidden}
.dsh-fleet-shell .fl-card-pad {padding:20px}
.dsh-fleet-shell .fl-card-head {padding:16px 20px;border-bottom:1px solid var(--fl-border);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsh-fleet-shell .fl-metrics {display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin:24px 0 30px}
.dsh-fleet-shell .fl-metric {padding:20px}
.dsh-fleet-shell .fl-metric strong {display:block;font-size:30px;font-weight:600;line-height:1.3;margin:10px 0}
.dsh-fleet-shell .fl-metric p {font-size:12px;color:var(--fl-muted)}
.dsh-fleet-shell .fl-columns {display:grid;grid-template-columns:minmax(0,1fr) 310px;gap:24px;align-items:start}
.dsh-fleet-shell .fl-grid {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:16px}
.dsh-fleet-shell .fl-table-scroll {overflow:auto;max-width:100%}
.dsh-fleet-shell table {width:100%;border-collapse:collapse;text-align:left;font-size:13px}
.dsh-fleet-shell th {font-size:12px;font-weight:500;color:var(--fl-muted);background:var(--fl-subtle)}
.dsh-fleet-shell th,.dsh-fleet-shell td {padding:14px 16px;border-bottom:1px solid var(--fl-border);vertical-align:middle}
.dsh-fleet-shell tr:last-child td {border-bottom:0}
.dsh-fleet-shell tbody tr:hover {background:var(--fl-subtle)}
.dsh-fleet-shell .fl-title-button {padding:0;border:0;color:inherit;background:none;text-align:left;font:inherit;font-weight:600;cursor:pointer;overflow-wrap:anywhere}
.dsh-fleet-shell .fl-title-button:hover {text-decoration:underline;text-underline-offset:3px}
.dsh-fleet-shell .fl-ticket-title {min-width:150px;max-width:460px;overflow-wrap:anywhere}
.dsh-fleet-shell .fl-toolbar {display:flex;align-items:center;gap:12px;justify-content:space-between;flex-wrap:wrap;margin:20px 0}
.dsh-fleet-shell input,.dsh-fleet-shell select,.dsh-fleet-shell textarea {font:inherit;font-size:13px;color:var(--fl-fg);background:var(--fl-bg);border:1px solid var(--fl-border);border-radius:8px;min-height:36px;max-width:100%;padding:8px 11px}
.dsh-fleet-shell textarea {resize:vertical;width:100%;min-height:110px;line-height:1.7}
.dsh-fleet-shell .fl-search {width:300px;max-width:100%}
.dsh-fleet-shell .fl-field {display:grid;gap:7px;font-size:13px;font-weight:500;min-width:0}
.dsh-fleet-shell .fl-field :is(input,select,textarea) {width:100%;font-weight:400}
.dsh-fleet-shell .fl-help {font-size:12px;color:var(--fl-muted);font-weight:400;overflow-wrap:anywhere}
.dsh-fleet-shell .fl-empty {padding:40px 24px;text-align:center;color:var(--fl-muted);display:grid;justify-items:center;gap:12px}
.dsh-fleet-shell .fl-notice {padding:14px 16px;background:var(--fl-subtle);border:1px solid var(--fl-border);border-radius:10px;overflow-wrap:anywhere}
.dsh-fleet-shell .fl-notice[role=alert] {border-color:color-mix(in srgb,#ef4444 40%,var(--fl-border))}
.dsh-fleet-shell .fl-session,.dsh-fleet-shell .fl-activity {padding:14px 0;border-bottom:1px solid var(--fl-border);overflow-wrap:anywhere}
.dsh-fleet-shell .fl-session:last-child,.dsh-fleet-shell .fl-activity:last-child {border:0}
.dsh-fleet-shell .fl-workbench {display:grid;grid-template-columns:minmax(0,1fr) minmax(310px,38%);gap:20px;align-items:start}
.dsh-fleet-shell .fl-flow {overflow:auto;padding:24px;min-height:260px;background:radial-gradient(var(--fl-border) .8px,transparent .8px) 0 0/18px 18px}
.dsh-fleet-shell .fl-flow-columns {display:flex;gap:28px;align-items:center;width:max-content;min-width:100%}
.dsh-fleet-shell .fl-flow-column {width:198px;display:grid;gap:20px;flex:0 0 auto}
.dsh-fleet-shell .fl-node {display:block;width:100%;padding:14px;border:1px solid var(--fl-border);border-radius:10px;color:var(--fl-fg);background:var(--fl-bg);text-align:left;cursor:pointer;font:inherit;position:relative;min-width:0}
.dsh-fleet-shell .fl-node:not(:disabled):hover {border-color:var(--fl-ring)}
.dsh-fleet-shell .fl-node[aria-pressed=true] {border-color:var(--fl-fg);box-shadow:0 0 0 1px var(--fl-fg)}
.dsh-fleet-shell .fl-node p {margin:9px 0 0;font-size:12px;overflow-wrap:anywhere;white-space:pre-wrap}
.dsh-fleet-shell .fl-node .fl-node-text {display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dsh-fleet-shell .fl-flow-column+.fl-flow-column .fl-node::before {content:'→';position:absolute;left:-22px;top:40%;color:var(--fl-muted)}
.dsh-fleet-shell .fl-gates {display:grid;gap:12px;padding:16px}
.dsh-fleet-shell .fl-gate {padding:12px;border:1px solid var(--fl-border);border-radius:8px;font-size:12px}
.dsh-fleet-shell .fl-message {white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.7}
.dsh-fleet-shell .fl-message[data-author=human] {border-radius:10px;padding:12px;background:var(--fl-subtle)}
.dsh-fleet-shell .fl-kv {display:grid;grid-template-columns:110px minmax(0,1fr);gap:12px;padding:10px 0;font-size:13px;overflow-wrap:anywhere}
.dsh-fleet-shell .fl-kv>span:first-child {color:var(--fl-muted)}
.dsh-fleet-shell pre {font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;margin:0}
.dsh-fleet-shell details {min-width:0}
.dsh-fleet-shell details>summary {cursor:pointer;color:var(--fl-muted);font-size:12px;padding:10px 0}
.dsh-fleet-shell .fl-dialog {color:var(--fl-fg);background:var(--fl-bg);border:1px solid var(--fl-border);border-radius:12px;padding:24px;width:min(640px,calc(100vw - 32px));max-height:calc(100dvh - 48px);overflow:auto;box-shadow:0 20px 60px #0004;margin:auto}
.dsh-fleet-shell .fl-dialog::backdrop {background:#0007}
.dsh-fleet-shell .fl-dialog-head {display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}
.dsh-fleet-shell .fl-dialog-actions {display:flex;justify-content:flex-end;gap:8px;margin-top:24px}
.dsh-fleet-shell .fl-loading {color:var(--fl-muted);padding:28px 0}
.dsh-fleet-shell .fl-control-row {display:flex;align-items:center;justify-content:space-between;gap:20px;padding:20px;border-bottom:1px solid var(--fl-border);min-width:0;flex-wrap:wrap}
.dsh-fleet-shell .fl-control-row:last-child {border:0}
.dsh-fleet-shell .fl-control-info {min-width:180px;flex:1}
.dsh-fleet-shell .fl-control-info p {overflow-wrap:anywhere;font-size:12px;color:var(--fl-muted);margin-top:6px}
.dsh-fleet-shell .fl-avatar {display:grid;place-items:center;width:36px;height:36px;flex-shrink:0;border-radius:10px;background:var(--fl-subtle);border:1px solid var(--fl-border);font-size:12px;font-weight:600}
@container fleet (max-width:1000px) {.dsh-fleet-shell .fl-columns {grid-template-columns:1fr}.dsh-fleet-shell .fl-workbench {grid-template-columns:1fr}.dsh-fleet-shell .fl-flow {max-height:420px}}
@container fleet (max-width:600px) {.dsh-fleet-shell .fl-metrics {grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.dsh-fleet-shell .fl-metric {padding:16px}.dsh-fleet-shell h1 {font-size:24px}.dsh-fleet-shell .fl-head {align-items:flex-start}.dsh-fleet-shell .fl-card-pad {padding:16px}.dsh-fleet-shell .fl-control-row {padding:16px}.dsh-fleet-shell .fl-crumb-actions {justify-content:flex-start;margin-inline-start:0;width:100%}}
@media(max-width:650px) {.dsh-fleet-shell {padding:20px 16px 28px;padding-block-start:max(20px,var(--dsh-frame-top-clearance,0px));padding-inline-start:max(16px,var(--dsh-frame-leading-clearance,0px))}}
@media(prefers-reduced-motion:reduce) {.dsh-fleet-shell * {scroll-behavior:auto!important;transition:none!important;animation:none!important}}
/* Ticket draft decision panel */
.dsh-fleet-shell .fl-draft {display:grid;gap:12px;min-width:0}
.dsh-fleet-shell .fl-dcard {border:1px solid var(--fl-border);border-radius:12px;background:var(--fl-bg);padding:12px;display:grid;gap:8px;min-width:0}
.dsh-fleet-shell .fl-dsec {font-size:12px;font-weight:600;color:var(--fl-muted)}
.dsh-fleet-shell .fl-dk {font-size:11.5px;font-weight:600;color:var(--fl-muted);margin-top:4px}
.dsh-fleet-shell .fl-dtitle {display:block;width:100%;min-width:0;text-align:left;font:inherit;font-size:15px;line-height:22px;font-weight:600;color:var(--fl-fg);background:transparent;border:1px solid transparent;border-radius:8px;padding:2px 6px;cursor:pointer;overflow-wrap:anywhere}
.dsh-fleet-shell button.fl-dtitle:hover {border-color:var(--fl-border);background:var(--fl-subtle)}
.dsh-fleet-shell input.fl-dtitle {cursor:text;background:var(--fl-bg);border-color:var(--fl-border);min-height:36px}
.dsh-fleet-shell .fl-eblock {display:block;width:100%;min-width:0;text-align:left;font:inherit;color:inherit;background:transparent;border:1px solid transparent;border-radius:8px;padding:6px 8px;cursor:pointer}
.dsh-fleet-shell .fl-eblock:hover {border-color:var(--fl-border);background:var(--fl-subtle)}
.dsh-fleet-shell .fl-eblock p {overflow-wrap:anywhere}
.dsh-fleet-shell .fl-iedit {display:grid;gap:8px;padding:8px;border:1px dashed var(--fl-ring);border-radius:8px;background:var(--fl-subtle);min-width:0}
.dsh-fleet-shell .fl-iedit textarea {min-height:72px}
.dsh-fleet-shell .fl-ibar {display:flex;justify-content:flex-end;gap:8px}
.dsh-fleet-shell .fl-linkbtn {background:none;border:none;padding:0;color:var(--fl-fg);font:inherit;font-size:12px;font-weight:500;cursor:pointer;justify-self:start}
.dsh-fleet-shell .fl-linkbtn:hover {text-decoration:underline}
.dsh-fleet-shell .fl-critlist {margin:0;padding:0;list-style:none;display:grid;gap:5px;counter-reset:flc}
.dsh-fleet-shell .fl-critlist li {display:flex;gap:8px;font-size:13px;align-items:baseline;overflow-wrap:anywhere;white-space:pre-wrap}
.dsh-fleet-shell .fl-read-values {margin:0;min-width:0;overflow-wrap:anywhere;font-size:13px}
.dsh-fleet-shell .fl-read-values dt {color:var(--fl-muted)}
.dsh-fleet-shell .fl-read-values dd {margin:0 0 8px 12px;white-space:pre-wrap}
.dsh-fleet-shell .fl-eblock:disabled {cursor:default;opacity:1}
.dsh-fleet-shell .fl-critlist li::before {counter-increment:flc;content:counter(flc);flex:0 0 17px;width:17px;height:17px;border-radius:999px;background:var(--fl-bg);border:1px solid var(--fl-border);color:var(--fl-muted);font-size:10.5px;font-weight:600;display:inline-grid;place-items:center}
.dsh-fleet-shell .fl-gflow {display:grid;gap:0;min-width:0}
.dsh-fleet-shell .fl-glink {width:2px;height:18px;background:var(--fl-border);justify-self:center;position:relative;flex-shrink:0}
.dsh-fleet-shell .fl-glink::after {content:'';position:absolute;left:50%;bottom:-3px;transform:translateX(-50%);width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:4px solid var(--fl-border)}
.dsh-fleet-shell .fl-gcard {display:flex;gap:10px;align-items:flex-start;width:100%;min-width:0;text-align:left;font:inherit;color:inherit;background:var(--fl-bg);border:1px solid var(--fl-border);border-radius:10px;padding:10px;cursor:pointer}
.dsh-fleet-shell .fl-gcard:hover {border-color:var(--fl-ring)}
.dsh-fleet-shell .fl-gcard .fl-gbody {display:grid;gap:2px;min-width:0;flex:1}
.dsh-fleet-shell .fl-gcard .fl-gbody strong {font-size:13px;overflow-wrap:anywhere}
.dsh-fleet-shell .fl-gic {flex:0 0 18px;width:18px;height:18px;color:var(--fl-muted);margin-top:2px}
.dsh-fleet-shell .fl-ggroup {border:1px solid var(--fl-border);border-radius:10px;padding:14px 8px 8px;position:relative;display:grid;gap:8px;min-width:0}
.dsh-fleet-shell .fl-ggroup .fl-gtab {position:absolute;top:-9px;left:10px;background:var(--fl-bg);border:1px solid var(--fl-border);border-radius:6px;padding:0 7px;font-size:11px;color:var(--fl-muted)}
@container fleet (min-width:560px) {.dsh-fleet-shell .fl-ggroup {grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}.dsh-fleet-shell .fl-ggroup .fl-gtab {grid-column:1/-1;justify-self:start}}
.dsh-fleet-shell .fl-popbackdrop {position:fixed;z-index:79;background:#0006}
.dsh-fleet-shell .fl-popout {position:fixed;z-index:80;display:flex;flex-direction:column;overflow:hidden;background:var(--fl-bg);color:var(--fl-fg);border:1px solid var(--fl-border);border-radius:12px;box-shadow:0 20px 60px #0006}
.dsh-fleet-shell[data-fleet-draft-artifact], .dsh-fleet-shell [data-fleet-draft-artifact] {position:relative}
.dsh-fleet-shell[data-fleet-draft-artifact] .fl-popbackdrop, .dsh-fleet-shell[data-fleet-draft-artifact] .fl-popout, .dsh-fleet-shell [data-fleet-draft-artifact] .fl-popbackdrop, .dsh-fleet-shell [data-fleet-draft-artifact] .fl-popout {position:absolute}
.dsh-fleet-shell .fl-pophead {flex:none;padding:12px 16px;border-bottom:1px solid var(--fl-border);background:var(--fl-bg)}
.dsh-fleet-shell .fl-pophead .fl-row {align-items:center}
.dsh-fleet-shell .fl-popbody {display:grid;gap:10px;align-content:start;padding:16px;overflow:auto;min-height:0}
.dsh-fleet-shell .fl-dfoot {position:sticky;bottom:0;background:var(--fl-bg);border-top:1px solid var(--fl-border);padding:8px 4px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
/* Dashboard redesign v0.1: compact strip, grouped dense list, board, workflow canvas */
.dsh-fleet-shell .fl-metrics.fl-strip {gap:0;padding:0 0 20px;margin:0 0 20px;border-bottom:1px solid var(--fl-border)}
.dsh-fleet-shell .fl-strip .fl-metric {border:0;border-left:1px solid var(--fl-border);border-radius:0;background:transparent;box-shadow:none;padding:0 0 0 20px}
.dsh-fleet-shell .fl-strip .fl-metric:first-child {border-left:0;padding-left:0}
.dsh-fleet-shell .fl-strip .fl-metric strong {font-size:26px;margin:4px 0}
.dsh-fleet-shell .fl-segment {display:inline-flex;background:var(--fl-subtle);border:1px solid var(--fl-border);border-radius:8px;padding:2px;gap:2px}
.dsh-fleet-shell .fl-segment button {border:0;background:none;padding:4px 10px;border-radius:6px;color:var(--fl-muted);font-size:12px;cursor:pointer}
.dsh-fleet-shell .fl-segment button[aria-pressed=true] {background:var(--fl-bg);color:var(--fl-fg);box-shadow:0 1px 2px #00000010}
.dsh-fleet-shell .fl-glist {border:1px solid var(--fl-border);border-radius:12px;background:var(--fl-bg);overflow:hidden}
.dsh-fleet-shell .fl-ghead {display:flex;align-items:center;gap:8px;height:34px;padding:0 16px;background:var(--fl-subtle);font-size:12px;font-weight:600;color:var(--fl-muted);border-bottom:1px solid var(--fl-border)}
.dsh-fleet-shell .fl-ghead .fl-count {color:var(--fl-muted);font-weight:400}
.dsh-fleet-shell .fl-grow {display:grid;grid-template-columns:110px 90px minmax(0,1fr) 170px 110px 90px;gap:14px;align-items:center;height:44px;padding:0 16px;border:0;border-bottom:1px solid var(--fl-border);cursor:pointer;width:100%;text-align:left;font:inherit;color:inherit;background:none}
.dsh-fleet-shell button.fl-grow {-webkit-appearance:none;appearance:none;border-radius:0}
.dsh-fleet-shell button.fl-grow:focus-visible {outline-offset:-2px}
.dsh-fleet-shell .fl-grow:last-child {border-bottom:0}
.dsh-fleet-shell .fl-grow:hover {background:var(--fl-subtle)}
.dsh-fleet-shell .fl-grow .fl-st {display:inline-flex;gap:7px;align-items:center;font-size:12px;font-weight:500}
.dsh-fleet-shell .fl-dot {width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block;flex:none}
.dsh-fleet-shell .fl-grow .fl-id {font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--fl-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-fleet-shell .fl-grow .fl-upd {white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-fleet-shell .fl-grow {overflow:hidden}
.dsh-fleet-shell .fl-grow .fl-ttl {min-width:0}
.dsh-fleet-shell .fl-grow .fl-ttl strong {display:block;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-fleet-shell .fl-grow .fl-ttl small {color:var(--fl-muted);font-size:11px}
.dsh-fleet-shell .fl-pips {display:flex;gap:3px}
.dsh-fleet-shell .fl-pips i {width:14px;height:4px;border-radius:2px;background:var(--fl-border)}
.dsh-fleet-shell .fl-pips i[data-s=completed] {background:color-mix(in srgb,#16a34a 70%,var(--fl-fg))}
.dsh-fleet-shell .fl-pips i[data-s=running] {background:color-mix(in srgb,#2563eb 70%,var(--fl-fg))}
.dsh-fleet-shell .fl-pips i[data-s=waiting] {background:color-mix(in srgb,#ca8a04 60%,var(--fl-fg))}
.dsh-fleet-shell .fl-pips i[data-s=failed],.dsh-fleet-shell .fl-pips i[data-s=interrupted] {background:color-mix(in srgb,#dc2626 70%,var(--fl-fg))}
.dsh-fleet-shell .fl-avstack {display:flex;padding-left:4px}
.dsh-fleet-shell .fl-avstack .fl-avatar {width:22px;height:22px;border-radius:7px;font-size:10px;margin-left:-6px;box-shadow:0 0 0 2px var(--fl-bg)}
.dsh-fleet-shell .fl-kanban {display:grid;grid-template-columns:repeat(4,minmax(220px,1fr));gap:16px;overflow:auto;padding-bottom:8px}
.dsh-fleet-shell .fl-kcol {min-width:0}
.dsh-fleet-shell .fl-khead {display:flex;gap:8px;align-items:center;margin-bottom:12px;font-size:12px;font-weight:600}
.dsh-fleet-shell .fl-kcard {display:block;width:100%;padding:14px;margin-bottom:10px;text-align:left;font:inherit;color:inherit;cursor:pointer}
.dsh-fleet-shell .fl-kcard:hover {border-color:var(--fl-ring)}
.dsh-fleet-shell .fl-kcard h3 {font-size:13px;margin:8px 0;overflow-wrap:anywhere}
.dsh-fleet-shell .fl-attention {background:var(--fl-subtle);border:1px solid var(--fl-border);border-radius:10px;padding:16px;margin-bottom:12px}
.dsh-fleet-shell .fl-attention h3 {display:flex;gap:8px;align-items:center;margin-bottom:6px}
.dsh-fleet-shell .fl-attention p {font-size:12px;line-height:1.7}
.dsh-fleet-shell .fl-timeline {display:flex;gap:10px;padding:10px 0;font-size:12px;border-bottom:1px solid var(--fl-border)}
.dsh-fleet-shell .fl-timeline:last-child {border-bottom:0}
.dsh-fleet-shell .fl-timeline .fl-dot {margin-top:6px}
.dsh-fleet-shell .fl-timeline p+p {font-size:11px;color:var(--fl-muted);margin-top:3px}
/* workflow canvas: equal-height, pan/zoom, fullscreen, full-size gate */
.dsh-fleet-shell .fl-workbench {align-items:stretch}
.dsh-fleet-shell .fl-flow {height:560px;overflow:hidden;position:relative;cursor:grab;padding:0;background:radial-gradient(var(--fl-border) .8px,transparent .8px) 0 0/18px 18px;user-select:none;-webkit-user-select:none;touch-action:none}
.dsh-fleet-shell .fl-flow[data-drag=true] {cursor:grabbing}
.dsh-fleet-shell .fl-flow-inner {position:absolute;left:0;top:0;transform-origin:0 0;padding:24px;width:max-content}
.dsh-fleet-shell .fl-workbench section[data-fleet-thread] {display:flex;flex-direction:column;min-height:0;height:100%;position:relative;overflow:hidden}
.dsh-fleet-shell .fl-thread-context {padding:8px 16px;flex:none;border-bottom:1px solid var(--fl-border)}
.dsh-fleet-shell .fl-thread-context .fl-summary {display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dsh-fleet-shell .fl-thread-context .fl-row {margin-top:4px}
.dsh-fleet-shell .fl-thread-context select {min-height:26px;font-size:12px;padding:2px 6px}
.dsh-fleet-shell .fl-thread-meta {display:flex;flex-wrap:wrap;align-items:center;column-gap:0;row-gap:2px;margin:2px 0 0;white-space:pre-wrap}
/* P-62 node plan: stage goal/tasks/outcomes and the declared tool/plugin/skill use */
.dsh-fleet-shell .fl-plan {display:grid;gap:0;padding:0 16px;flex:none;min-width:0}
.dsh-fleet-shell .fl-plan-block {padding:12px 0;border-bottom:1px solid var(--fl-border);min-width:0}
.dsh-fleet-shell .fl-plan-block:last-child {border-bottom:0}
.dsh-fleet-shell .fl-plan-block h3 {font-size:12px;font-weight:600;color:var(--fl-muted);margin:0 0 6px}
.dsh-fleet-shell .fl-plan-goal {font-size:13px;line-height:1.6;margin:0 0 8px;overflow-wrap:anywhere}
.dsh-fleet-shell .fl-plan-list {margin:0 0 8px;padding-inline-start:18px;display:grid;gap:4px;font-size:13px;line-height:1.55;overflow-wrap:anywhere}
.dsh-fleet-shell .fl-plan-list:last-child {margin-bottom:0}
.dsh-fleet-shell .fl-plan-outcome>.fl-row {align-items:center;gap:8px;flex-wrap:wrap}
.dsh-fleet-shell .fl-capability-block {border:1px solid var(--fl-border);border-radius:10px;background:var(--fl-subtle);padding:4px 12px;min-width:0}
.dsh-fleet-shell .fl-plan-group {padding:7px 0;font-size:13px;font-weight:400;line-height:1.4}
.dsh-fleet-shell .fl-plan-group+.fl-plan-group {border-top:1px solid var(--fl-border)}
.dsh-fleet-shell .fl-plan-group-title {margin:0 0 3px;font-size:12px;color:var(--fl-muted);font-weight:600}
.dsh-fleet-shell .fl-plan-names {list-style:none;margin:0;padding:0;overflow-wrap:anywhere}
.dsh-fleet-shell .fl-plan-names li {padding:1px 0;font-weight:400}
.dsh-fleet-shell .fl-plan-use-details {border-top:1px solid var(--fl-border)}
.dsh-fleet-shell .fl-plan-use-details>summary {padding:7px 0}
.dsh-fleet-shell .fl-chip[data-fleet-chip-kind=skill] {border-style:dashed;color:var(--fl-fg)}
.dsh-fleet-shell .fl-plan-chips {flex-wrap:wrap;gap:4px;margin-top:4px}
.dsh-fleet-shell .fl-chip {display:inline-flex;align-items:center;max-width:100%;padding:1px 7px;border:1px solid var(--fl-border);border-radius:999px;background:var(--fl-subtle);color:var(--fl-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-fleet-shell .fl-seat {display:inline-flex;min-width:0;max-width:100%}
.dsh-fleet-shell .fl-seat-trigger {display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:240px;height:20px;margin:0 -2px;padding:0 4px;border:0;border-radius:5px;background:transparent;color:var(--fl-fg);font:inherit;font-size:inherit;line-height:20px;white-space:nowrap;cursor:pointer}
.dsh-fleet-shell .fl-seat-trigger:hover,.dsh-fleet-shell .fl-seat-trigger:focus-visible,.dsh-fleet-shell .fl-seat-trigger:has(+ :popover-open) {background:var(--fl-subtle)}
.dsh-fleet-shell .fl-seat-trigger:disabled {cursor:default;opacity:.6}
.dsh-fleet-shell .fl-seat-label {min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-fleet-shell .fl-seat-chevron {flex:none;display:inline-flex;color:var(--dsw-alias-menu-icon,var(--fl-muted));font-size:11px;line-height:1}
.dsh-fleet-shell .fl-seat-saving {display:inline-block;animation:fl-seat-spin .9s linear infinite}
@keyframes fl-seat-spin {to {transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce) {.dsh-fleet-shell .fl-seat-saving {animation:none}}
.dsh-fleet-shell .fl-seat-missing {flex:none;padding:0 5px;border:1px solid var(--fl-border);border-radius:4px;color:var(--fl-muted);font-size:10.5px;line-height:15px}
.dsh-fleet-shell .fl-seat-menu {position:fixed;inset:auto;margin:4px 0;position-area:block-end span-inline-end;position-try-fallbacks:flip-block,flip-inline,flip-block flip-inline;width:max-content;min-width:200px;max-width:min(280px,calc(100vw - 24px));max-height:min(320px,60dvh);overflow:auto;overscroll-behavior:contain;padding:4px;border:1px solid var(--fl-border);border-radius:8px;background:var(--dsw-alias-bg-base,var(--fl-bg));color:var(--fl-fg);font-size:12px;box-shadow:0 6px 20px color-mix(in srgb,#000 22%,transparent)}
.dsh-fleet-shell .fl-seat-menu button {display:flex;align-items:center;gap:8px;width:100%;min-height:28px;padding:4px 8px;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;font-size:12px;font-weight:400;text-align:start;cursor:pointer;outline:none}
.dsh-fleet-shell .fl-seat-menu button:is(:hover,:focus-visible),.dsh-fleet-shell .fl-seat-menu:has(input:focus) button[data-highlighted=true] {background:var(--fl-subtle)}
.dsh-fleet-shell .fl-seat-menu button:disabled {cursor:default;opacity:.55}
.dsh-fleet-shell .fl-seat-row .fl-seat-label {flex:none;color:var(--fl-fg)}
.dsh-fleet-shell .fl-seat-value {flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:end;color:var(--fl-muted)}
.dsh-fleet-shell .fl-seat-menu [role=menuitemradio] .fl-seat-label {flex:1}
.dsh-fleet-shell .fl-seat-check {flex:none;width:12px;text-align:center;color:var(--fl-fg)}
.dsh-fleet-shell .fl-seat-back {color:var(--fl-muted)!important}
.dsh-fleet-shell .fl-seat-search {display:block;width:100%;min-height:28px;margin:0 0 2px;padding:3px 8px;border:0;border-radius:0;background:transparent;font-size:12px;outline:none}
.dsh-fleet-shell .fl-seat-search::placeholder {color:var(--fl-muted)}
.dsh-fleet-shell .fl-seat-heading {margin:0;padding:6px 8px 2px;color:var(--fl-muted);font-size:11px}
.dsh-fleet-shell .fl-seat-sep {height:1px;margin:4px 6px;background:var(--fl-border)}
.dsh-fleet-shell .fl-seat-error {margin:4px 4px 2px;padding:4px 6px;color:color-mix(in srgb,#ef4444 80%,var(--fl-fg));font-size:11.5px}
.dsh-fleet-shell .fl-workbench section[data-fleet-thread] > .fl-card-head,.dsh-fleet-shell .fl-workbench section[data-fleet-thread] > .fl-statusline,.dsh-fleet-shell .fl-workbench section[data-fleet-thread] > .fl-card-pad {flex:none}
.dsh-fleet-shell .fl-workbench section[data-fleet-gate-inspector] {align-content:start;overflow:auto;max-height:680px}
.dsh-fleet-shell .fl-todos {margin:8px 0}
.dsh-fleet-shell .fl-todo {padding:8px 12px;border:1px solid var(--fl-border);border-radius:8px;background:var(--fl-subtle)}
.dsh-fleet-shell .fl-todo+.fl-todo {margin-top:4px}
.dsh-fleet-shell .fl-flowctl {display:flex;align-items:center;gap:8px}
.dsh-fleet-shell .fl-node-gate {border-style:dashed;border-color:color-mix(in srgb,#ca8a04 55%,var(--fl-border))}
.dsh-fleet-shell .fl-flowfull {position:fixed;inset:0;z-index:90;background:var(--fl-bg);color:var(--fl-fg);display:flex;flex-direction:column}
.dsh-fleet-shell .fl-flowfull-head {height:48px;flex:none;display:flex;align-items:center;gap:12px;padding:0 18px;border-bottom:1px solid var(--fl-border)}
.dsh-fleet-shell .fl-flowfull .fl-flow {flex:1;height:auto;min-height:0}
@container fleet (max-width:1000px) {.dsh-fleet-shell .fl-workbench section[data-fleet-thread] {height:auto;max-height:max(480px,72vh)}.dsh-fleet-shell .fl-flow {height:420px;max-height:420px}.dsh-fleet-shell .fl-kanban {grid-template-columns:repeat(2,minmax(200px,1fr))}}
@container fleet (max-width:600px) {.dsh-fleet-shell .fl-grow {grid-template-columns:90px minmax(0,1fr) 90px;height:auto;padding:10px 12px;row-gap:4px}.dsh-fleet-shell .fl-grow .fl-id,.dsh-fleet-shell .fl-grow .fl-avstack,.dsh-fleet-shell .fl-grow .fl-upd {display:none}.dsh-fleet-shell .fl-kanban {grid-template-columns:1fr}.dsh-fleet-shell .fl-strip .fl-metric {padding-left:12px}}
/* Ticket readability v0.1 (P-55/P-56): title+goal+blocker header, collapsed criteria, deliverable file manifest,
   adaptive incompatible rows with preview, one-line empty attention. Monochrome accents only. */
.dsh-fleet-shell .fl-goal {margin:2px 0 8px;font-size:13.5px;line-height:1.55}
.dsh-fleet-shell .fl-blocker {display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;margin:2px 0 10px}
.dsh-fleet-shell .fl-blocker .fl-btn {font-size:11.5px;padding:2px 10px}
.dsh-fleet-shell .fl-summary {font-size:13px;line-height:1.5;margin:0 0 4px}
.dsh-fleet-shell .fl-attention-empty {font-size:12.5px;color:var(--fl-muted);border:1px dashed var(--fl-border);border-radius:8px;padding:8px 12px;margin:0 0 6px}
.dsh-fleet-shell .fl-filelist {list-style:none;margin:4px 0 0;padding:0;display:grid;gap:2px}
.dsh-fleet-shell .fl-file {display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr) auto;gap:10px;align-items:center;font-size:12px;padding:4px 0;border-bottom:1px dashed color-mix(in srgb,var(--fl-border) 60%,transparent)}
.dsh-fleet-shell .fl-file:last-child {border-bottom:0}
.dsh-fleet-shell .fl-file-purpose {color:var(--fl-fg);overflow-wrap:anywhere}
.dsh-fleet-shell .fl-file-path {color:var(--fl-muted);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:ltr}
.dsh-fleet-shell .fl-pre-wrap {white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
.dsh-fleet-shell .fl-grow-notice {height:auto;min-height:44px;padding:10px 16px;align-items:start;row-gap:4px;cursor:default}
.dsh-fleet-shell .fl-grow-notice .fl-ttl small {display:block;margin-top:3px;white-space:normal;overflow:visible}
.dsh-fleet-shell details summary {cursor:pointer;user-select:none}@container fleet (max-width:600px) {.dsh-fleet-shell .fl-file {grid-template-columns:minmax(0,1fr) auto}.dsh-fleet-shell .fl-file-purpose {grid-column:1/-1}.dsh-fleet-shell .fl-grow-notice .fl-id,.dsh-fleet-shell .fl-grow-notice .fl-upd {display:none}}
/* P4 shared-definition lists (redesign §5): dense rows reuse the fl-grow language. Monochrome accents only. */
.dsh-fleet-shell .fl-lrow {grid-template-columns:minmax(0,1.5fr) 140px 160px 80px 64px 130px}
.dsh-fleet-shell .fl-lrow .fl-ttl {display:flex;align-items:center;gap:10px;min-width:0}
.dsh-fleet-shell .fl-lrow .fl-avatar {width:24px;height:24px;border-radius:8px;font-size:11px;flex-shrink:0}
.dsh-fleet-shell .fl-lname {display:grid;min-width:0;gap:1px}
.dsh-fleet-shell .fl-lname small {white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-fleet-shell .fl-lrow .fl-cell {white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:var(--fl-muted)}
.dsh-fleet-shell .fl-lrow .fl-cell.fl-mono {font-family:ui-monospace,Consolas,monospace}
.dsh-fleet-shell .fl-lrow .fl-lact {display:flex;justify-content:flex-end}
.dsh-fleet-shell .fl-lact .fl-btn {font-size:11.5px;padding:4px 10px}
.dsh-fleet-shell .fl-lrow:hover {background:transparent}
.dsh-fleet-shell .fl-drow {grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) minmax(0,1.2fr) 130px}
.dsh-fleet-shell .fl-drow .fl-ttl {gap:8px}
.dsh-fleet-shell .fl-drow .fl-ttl strong {overflow:hidden;text-overflow:ellipsis}
@container fleet (max-width:600px) {.dsh-fleet-shell .fl-lrow {grid-template-columns:minmax(0,1fr) auto;height:auto;padding:10px 12px;row-gap:4px}.dsh-fleet-shell .fl-lrow .fl-cell:not(.fl-lact) {display:none}.dsh-fleet-shell .fl-drow {grid-template-columns:minmax(0,1fr) auto}.dsh-fleet-shell .fl-drow .fl-cell.fl-mono {display:none}}
/* Ticket first-screen density: deliverables render as one-line disclosure rows so flow and thread stay in view. */
.dsh-fleet-shell .fl-ticket-meta {margin-bottom:8px;padding-bottom:8px;border-bottom:1px dashed var(--fl-border)}
.dsh-fleet-shell .fl-ticket-meta .fl-btn {font-size:11.5px;padding:3px 9px}
.dsh-fleet-shell .fl-dlist {margin-top:10px;border:1px solid var(--fl-border);border-radius:10px;overflow:hidden}
.dsh-fleet-shell .fl-ditem + .fl-ditem {border-top:1px solid var(--fl-border)}
.dsh-fleet-shell .fl-ditem > summary {display:grid;grid-template-columns:minmax(0,1.6fr) 64px 76px 76px 96px 64px 18px;gap:12px;align-items:center;min-height:40px;padding:4px 14px;font-size:13px;list-style:none}
.dsh-fleet-shell .fl-ditem > summary::-webkit-details-marker {display:none}
.dsh-fleet-shell .fl-ditem > summary::after {content:'▸';color:var(--fl-muted);justify-self:end}
.dsh-fleet-shell .fl-ditem[open] > summary::after {content:'▾'}
.dsh-fleet-shell .fl-ditem > summary:hover,.dsh-fleet-shell .fl-ditem[open] > summary {background:var(--fl-subtle)}
.dsh-fleet-shell .fl-ditem > summary .fl-ttl {min-width:0}
.dsh-fleet-shell .fl-ditem > summary .fl-ttl strong {display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-fleet-shell .fl-ditem > summary .fl-cell {white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:var(--fl-muted)}
.dsh-fleet-shell .fl-ditem > summary .fl-num {font-variant-numeric:tabular-nums}
.dsh-fleet-shell .fl-dbody {padding:10px 16px 12px;border-top:1px dashed var(--fl-border)}
@container fleet (max-width:600px) {.dsh-fleet-shell .fl-ditem > summary {grid-template-columns:minmax(0,1fr) 96px 56px 16px}.dsh-fleet-shell .fl-ditem > summary > .fl-cell:nth-child(-n+4) {display:none}}
/* Raw-data zone at the page bottom: deliberately secondary — dashed frame, muted heading and summaries. */
.dsh-fleet-shell .fl-rawdata {border-style:dashed}
/* Long agent free text: one muted preview line until the reader opts in; capped body when expanded. */
.dsh-fleet-shell .fl-clamp > summary {display:flex;gap:8px;align-items:baseline;cursor:pointer;color:var(--fl-muted);line-height:1.55;padding:2px 0;list-style:none}
.dsh-fleet-shell .fl-clamp > summary::-webkit-details-marker {display:none}
.dsh-fleet-shell .fl-clamp > summary::before {content:'▸';flex-shrink:0}
.dsh-fleet-shell .fl-clamp[open] > summary::before {content:'▾'}
.dsh-fleet-shell .fl-clamp > summary:hover {color:inherit}
.dsh-fleet-shell .fl-clamp > .fl-pre-wrap {max-height:340px;overflow:auto;margin:6px 0 2px}
.dsh-fleet-shell .fl-statusline {display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;padding:10px 18px;border-bottom:1px solid var(--fl-border);font-size:12px;color:var(--fl-muted)}
.dsh-fleet-shell .fl-statusline .fl-badge {font-size:11px}
.dsh-fleet-shell .fl-dot {width:7px;height:7px;border-radius:50%;background:var(--fl-border);border:1px solid var(--fl-muted);justify-self:center}
.dsh-fleet-shell .fl-avatar {width:20px;height:20px;border-radius:50%;background:var(--fl-bg);border:1px solid var(--fl-border);display:inline-flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:600;color:var(--fl-muted);flex-shrink:0}
.dsh-fleet-shell .fl-rawdata h2 {font-size:14px;color:var(--fl-muted)}
.dsh-fleet-shell .fl-rawdata summary {color:var(--fl-muted)}
.dsh-fleet-shell .fl-rawdata summary:hover {color:inherit}
.dsh-fleet-shell .fl-schedrow {border-top:1px solid var(--fl-border);padding:16px 0;min-width:0;overflow-wrap:anywhere}
.dsh-fleet-shell .fl-schedmain {align-items:flex-start;flex-wrap:wrap}
.dsh-fleet-shell .fl-schedmeta {font-variant-numeric:tabular-nums;gap:3px}
.dsh-fleet-shell .fl-weekdays {flex-wrap:wrap}
.dsh-fleet-shell .fl-weekdays button[aria-pressed=true] {background:var(--fl-fg);color:var(--fl-bg)}
/* P-68 schedule calendar: month/week/day views, subtle-fill Ticket cards, occurrence popover.
   Same monochrome language: fg/bg mixes, hairlines only where structure needs them,
   panel min-height fills the window so scrolling belongs to the page, not a half panel. */
.dsh-fleet-shell .fl-cal-head {display:flex;justify-content:space-between;align-items:flex-end;gap:20px;flex-wrap:wrap;margin:22px 0 18px}
.dsh-fleet-shell .fl-cal-tools {display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-fleet-shell .fl-cal-range {font-size:12px;color:var(--fl-muted);font-variant-numeric:tabular-nums;min-width:150px;text-align:end}
.dsh-fleet-shell .fl-cal-nav {display:inline-flex;gap:2px}
.dsh-fleet-shell .fl-cal-nav button {min-height:30px;padding:4px 10px;font-size:12px}
.dsh-fleet-shell .fl-cal-view {display:flex;flex-direction:column;min-height:max(420px,calc(100dvh - 330px));border:1px solid var(--fl-border);border-radius:12px;background:var(--fl-bg);overflow:hidden}
.dsh-fleet-shell .fl-cal-week {display:grid;grid-template-columns:repeat(7,minmax(0,1fr));flex:1 1 auto;min-height:0}
.dsh-fleet-shell .fl-cal-col {display:flex;flex-direction:column;padding-bottom:8px;min-width:0;min-height:160px}
.dsh-fleet-shell .fl-cal-col[data-today=true] {background:var(--fl-subtle)}
.dsh-fleet-shell .fl-cal-day {display:flex;align-items:baseline;justify-content:space-between;gap:8px;width:100%;flex:none;padding:10px 12px 8px;border:0;border-bottom:1px solid var(--fl-border);background:none;color:var(--fl-muted);font:inherit;font-size:12px;text-align:start;cursor:pointer}
.dsh-fleet-shell .fl-cal-day:hover {color:var(--fl-fg)}
.dsh-fleet-shell .fl-cal-day strong {font-size:13px;font-weight:600;color:var(--fl-fg);font-variant-numeric:tabular-nums}
.dsh-fleet-shell .fl-cal-day[aria-current=date] {color:var(--fl-fg)}
.dsh-fleet-shell .fl-cal-day[aria-current=date] strong {text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
.dsh-fleet-shell .fl-cal-stack {display:grid;gap:6px;padding:8px 8px 2px;align-content:start}
.dsh-fleet-shell .fl-cal-ev {display:grid;gap:6px;width:100%;padding:10px 11px;border:1px solid transparent;border-radius:8px;background:var(--fl-subtle);color:var(--fl-fg);font:inherit;text-align:start;cursor:pointer}
.dsh-fleet-shell .fl-cal-ev:hover {background:color-mix(in srgb,var(--fl-fg) 7%,var(--fl-bg))}
.dsh-fleet-shell .fl-cal-name {font-size:13px;font-weight:600;line-height:1.45;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dsh-fleet-shell .fl-cal-foot {display:flex;align-items:center;justify-content:space-between;gap:6px;min-width:0}
.dsh-fleet-shell .fl-cal-time {display:inline-flex;align-items:baseline;gap:5px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--fl-fg);white-space:nowrap}
.dsh-fleet-shell .fl-cal-time small {font-family:inherit;font-size:10.5px;color:var(--fl-muted)}
.dsh-fleet-shell .fl-cal-ev .fl-badge {flex:none;font-size:10px;line-height:17px;padding:0 6px}
.dsh-fleet-shell .fl-cal-src {font-size:11px;color:var(--fl-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-fleet-shell .fl-cal-empty {margin:0;padding:0 2px;font-size:11.5px;color:var(--fl-muted)}
.dsh-fleet-shell .fl-cal-mwrap {display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow:auto}
.dsh-fleet-shell .fl-cal-mhead {padding:9px 12px;border-bottom:1px solid var(--fl-border);background:var(--fl-subtle);font-size:11.5px;font-weight:500;color:var(--fl-muted)}
.dsh-fleet-shell .fl-cal-month {display:grid;grid-template-columns:repeat(7,minmax(0,1fr));flex:1 1 auto;grid-auto-rows:minmax(min-content,1fr);min-height:0}
.dsh-fleet-shell .fl-cal-mcell {display:grid;align-content:start;gap:3px;min-height:88px;min-width:0;padding:8px 10px 7px;border-bottom:1px solid var(--fl-border);cursor:pointer}
.dsh-fleet-shell .fl-cal-mcell:nth-last-child(-n+7) {border-bottom:0}
.dsh-fleet-shell .fl-cal-mcell[data-out=true] {opacity:.45}
.dsh-fleet-shell .fl-cal-mcell[data-today=true] {background:var(--fl-subtle)}
.dsh-fleet-shell .fl-cal-mcell:hover {background:var(--fl-subtle)}
.dsh-fleet-shell .fl-cal-mdn {font-size:12px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--fl-fg);margin-bottom:2px}
.dsh-fleet-shell .fl-cal-mcell[data-out=true] .fl-cal-mdn {color:var(--fl-muted)}
.dsh-fleet-shell .fl-cal-mcell[data-today=true] .fl-cal-mdn {font-weight:650;text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
.dsh-fleet-shell .fl-cal-mitem {display:flex;align-items:center;gap:6px;min-width:0;font-size:11.5px;color:var(--fl-fg)}
.dsh-fleet-shell .fl-cal-mitem>.fl-dot {flex:none;width:5px;height:5px;border:0;background:var(--fl-muted)}
.dsh-fleet-shell .fl-cal-mitem[data-tone=failed]>.fl-dot {background:color-mix(in srgb,#dc2626 70%,var(--fl-fg))}
.dsh-fleet-shell .fl-cal-mitem[data-tone=done]>.fl-dot {background:color-mix(in srgb,#16a34a 70%,var(--fl-fg))}
.dsh-fleet-shell .fl-cal-mitem[data-tone=paused]>.fl-dot {background:color-mix(in srgb,#ca8a04 65%,var(--fl-fg))}
.dsh-fleet-shell .fl-cal-mtime {flex:none;font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--fl-muted);font-variant-numeric:tabular-nums}
.dsh-fleet-shell .fl-cal-mname {min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-fleet-shell .fl-cal-more {justify-self:start;border:0;background:none;padding:1px 0 0;color:var(--fl-muted);font:inherit;font-size:11px;cursor:pointer}
.dsh-fleet-shell .fl-cal-more:hover {color:var(--fl-fg);text-decoration:underline;text-underline-offset:2px}
.dsh-fleet-shell .fl-cal-dayview {flex:1 1 auto;max-width:760px;padding:20px 20px 22px;min-height:0}
.dsh-fleet-shell .fl-cal-dayview h2 {margin-bottom:12px}
.dsh-fleet-shell .fl-cal-legend {display:flex;flex-wrap:wrap;gap:8px 18px;flex:none;padding:10px 16px 11px;font-size:11.5px;color:var(--fl-muted)}
.dsh-fleet-shell .fl-cal-legend span {display:inline-flex;align-items:center;gap:6px}
.dsh-fleet-shell .fl-cal-legend .fl-dot {width:5px;height:5px;border:0;background:var(--fl-muted)}
.dsh-fleet-shell .fl-cal-legend [data-tone=done] {background:color-mix(in srgb,#16a34a 70%,var(--fl-fg))}
.dsh-fleet-shell .fl-cal-legend [data-tone=failed] {background:color-mix(in srgb,#dc2626 70%,var(--fl-fg))}
.dsh-fleet-shell .fl-cal-legend [data-tone=paused] {background:color-mix(in srgb,#ca8a04 65%,var(--fl-fg))}
.dsh-fleet-shell .fl-cal-pop {position:fixed;width:340px;max-width:calc(100vw - 40px);border:1px solid var(--fl-border);border-radius:12px;background:var(--fl-bg);color:var(--fl-fg);box-shadow:0 20px 60px #0006;z-index:80;display:flex;flex-direction:column}
.dsh-fleet-shell .fl-cal-pophead {display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--fl-border)}
.dsh-fleet-shell .fl-cal-pophead strong {font-size:13px;font-weight:600;overflow-wrap:anywhere}
.dsh-fleet-shell .fl-cal-popbody {display:grid;gap:10px;padding:14px 16px 16px}
.dsh-fleet-shell .fl-cal-kv {display:grid;grid-template-columns:58px minmax(0,1fr);gap:10px;font-size:12px;align-items:baseline}
.dsh-fleet-shell .fl-cal-kv>span:first-child {color:var(--fl-muted)}
.dsh-fleet-shell .fl-cal-kv .fl-mono {font-size:11.5px}
.dsh-fleet-shell .fl-cal-actions {display:grid;gap:6px;padding-top:6px;margin-top:2px;border-top:1px solid var(--fl-border)}
.dsh-fleet-shell .fl-cal-actions .fl-btn {width:100%;justify-content:flex-start;font-size:12px;min-height:32px;padding:5px 10px;box-shadow:none}
.dsh-fleet-shell .fl-cal-actions .fl-btn:not(.fl-btn-ghost) {background:transparent}
.dsh-fleet-shell .fl-cal-actions .fl-btn:not(.fl-btn-ghost):hover {background:var(--fl-subtle)}
.dsh-fleet-shell .fl-cal-actions .fl-btn-ghost {color:var(--fl-muted)}
.dsh-fleet-shell .fl-cal-actions .fl-cal-hint {font-size:11.5px;color:var(--fl-muted);padding:2px 2px 0}
.dsh-fleet-shell .fl-cal-allseries {margin-top:16px}
.dsh-fleet-shell .fl-cal-allseries>summary {font-size:12px;color:var(--fl-muted)}
.dsh-fleet-shell .fl-cal-allseries>summary:hover {color:var(--fl-fg)}
@container fleet (max-width:1000px) {.dsh-fleet-shell .fl-cal-week {grid-template-columns:repeat(4,minmax(0,1fr))}.dsh-fleet-shell .fl-cal-mwrap {display:none}}
@container fleet (max-width:600px) {.dsh-fleet-shell .fl-cal-week {grid-template-columns:1fr}.dsh-fleet-shell .fl-cal-col {min-height:0;border-bottom:1px solid var(--fl-border)}.dsh-fleet-shell .fl-cal-col:last-child {border-bottom:0}.dsh-fleet-shell .fl-cal-range {text-align:start;min-width:0}}
/* Workspace overview and its shared ticket list. */
.dsh-fleet-shell .fl-overview-heading {display:flex;align-items:center;justify-content:space-between;min-height:36px;margin-bottom:12px;gap:12px}
.dsh-fleet-shell .fl-overview section {min-width:0}
.dsh-fleet-shell .fl-strip .fl-metric strong {font-size:28px;line-height:1.25;font-variant-numeric:tabular-nums;margin:0 0 2px;color:var(--fl-tone)}
.dsh-fleet-shell [data-tone=running] {--fl-tone:var(--fl-running)}
.dsh-fleet-shell [data-tone=waiting] {--fl-tone:var(--fl-waiting)}
.dsh-fleet-shell [data-tone=danger] {--fl-tone:var(--fl-danger)}
.dsh-fleet-shell [data-tone=success] {--fl-tone:var(--fl-success)}
.dsh-fleet-shell .fl-overview .fl-badge {border-radius:4px;line-height:18px;padding:1px 6px}
.dsh-fleet-shell .fl-strip .fl-badge {margin-top:6px;white-space:normal}
.dsh-fleet-shell .fl-glist {container:ticket-list / inline-size;background:var(--fl-subtle);border-radius:8px}
.dsh-fleet-shell .fl-ghead {background:color-mix(in srgb,var(--fl-fg) 2%,var(--fl-bg))}
.dsh-fleet-shell :is(.fl-overview,.fl-glist) .fl-dot {width:6px;height:6px;border:0;background:currentColor}
.dsh-fleet-shell .fl-stage {display:grid;gap:3px;min-width:0}
.dsh-fleet-shell .fl-stage-label {color:var(--fl-muted);font-size:11px;line-height:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-fleet-shell .fl-stage .fl-pips {overflow:hidden}
.dsh-fleet-shell .fl-avstack .fl-avatar {color:var(--fl-tone,var(--fl-muted));background:color-mix(in srgb,currentColor 13%,var(--fl-bg));border-radius:6px}
.dsh-fleet-shell .fl-grow-notice {grid-template-columns:110px 90px minmax(0,1fr) max-content 90px;align-items:center}
.dsh-fleet-shell .fl-grow-actions {gap:6px}
.dsh-fleet-shell .fl-grow-actions .fl-btn {min-height:30px;padding:3px 8px;font-size:12px;white-space:nowrap}
.dsh-fleet-shell .fl-attention {border-radius:8px;overflow-wrap:anywhere;margin-bottom:0}
.dsh-fleet-shell .fl-attention+.fl-attention {margin-top:12px}
.dsh-fleet-shell .fl-attention .fl-btn {margin-top:10px;min-height:30px;padding:3px 10px}
.dsh-fleet-shell .fl-timeline {overflow-wrap:anywhere}
.dsh-fleet-shell .fl-activity-action {font-weight:600}
.dsh-fleet-shell .fl-activity-meta {color:var(--fl-muted);font-size:11px;margin-top:3px}
.dsh-fleet-shell .fl-activity-meta .fl-title-button {color:inherit;font:inherit;text-align:start}
@container ticket-list (max-width:860px) {
  .dsh-fleet-shell .fl-grow {grid-template-columns:92px minmax(0,1.5fr) minmax(0,1fr) 76px;gap:8px}
  .dsh-fleet-shell .fl-grow .fl-id,.dsh-fleet-shell .fl-grow .fl-upd {display:none}
  .dsh-fleet-shell .fl-grow-notice {grid-template-columns:92px minmax(0,1fr)}
  .dsh-fleet-shell .fl-grow-actions {grid-column:2/-1}
}
@container ticket-list (max-width:560px) {
  .dsh-fleet-shell .fl-grow {grid-template-columns:auto minmax(0,1fr);height:auto;padding:8px 10px}
  .dsh-fleet-shell .fl-grow .fl-avstack {display:none}
  .dsh-fleet-shell .fl-stage {grid-column:2}
  .dsh-fleet-shell .fl-grow-actions {grid-column:1/-1}
  .dsh-fleet-shell .fl-grow-actions .fl-btn {white-space:normal}
}
@container fleet (max-width:600px) {
  .dsh-fleet-shell .fl-metrics.fl-strip {row-gap:16px}
  .dsh-fleet-shell .fl-strip .fl-metric:nth-child(odd) {border-left:0;padding-left:0}
}
/* Side-pane surface: the shared Ticket detail inside the right sidebar. Compact
   chrome; the container queries above keep the same responsive layout. */
.dsh-fleet-shell[data-fleet-surface=side-pane] {padding:16px 18px 24px;padding-block-start:max(16px,var(--dsh-frame-top-clearance,0px))}
.dsh-fleet-shell .fl-dialog.fl-pane-editor {position:static;width:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;overflow:visible;box-shadow:none}
.dsh-fleet-shell[data-fleet-surface=side-pane] .fl-content {max-width:none}
.dsh-fleet-shell[data-fleet-surface=side-pane] .fl-crumb {margin-bottom:12px}
.dsh-fleet-shell[data-fleet-surface=side-pane] .fl-flow {height:320px}
.dsh-fleet-shell[data-fleet-surface=side-pane] .fl-card-pad {padding:16px}
/* Fleet overview navigation and cross-workspace rows. */
.dsh-fleet-shell .fl-overview-nav {
  display:flex;align-items:center;justify-content:space-between;gap:12px;
  margin-top:22px;padding:4px 0 14px;border-bottom:1px solid var(--fl-border);
}
.dsh-fleet-shell .fl-overview-nav-group {
  display:flex;flex-wrap:wrap;gap:4px;padding:4px;
  border:1px solid var(--fl-border);border-radius:11px;background:var(--fl-subtle);
}
.dsh-fleet-shell .fl-overview-nav .fl-btn {
  min-height:34px;padding:6px 13px;border-color:transparent;border-radius:7px;
  background:transparent;box-shadow:none;color:var(--fl-muted);white-space:nowrap;
}
.dsh-fleet-shell .fl-overview-nav .fl-btn:hover {
  background:color-mix(in srgb,var(--fl-fg) 7%,var(--fl-bg));color:var(--fl-fg);
}
.dsh-fleet-shell .fl-overview-nav .fl-btn[aria-current=page] {
  border-color:var(--fl-border);background:var(--fl-bg);color:var(--fl-fg);
  font-weight:600;box-shadow:0 1px 2px color-mix(in srgb,var(--fl-fg) 12%,transparent);
}
.dsh-fleet-shell .fl-overview-nav .fl-btn:focus-visible {outline-offset:0}
.dsh-fleet-shell .fl-overview-nav [data-fleet-root-tab=settings] {
  min-height:36px;border-color:var(--fl-border);background:var(--fl-bg);color:var(--fl-fg);
}
.dsh-fleet-shell .fl-overview-nav [data-fleet-root-tab=settings][aria-current=page] {
  border-color:var(--fl-ring);background:var(--fl-subtle);
}
@container fleet (max-width:540px) {
  .dsh-fleet-shell .fl-overview-nav {flex-wrap:wrap;gap:8px}
  .dsh-fleet-shell .fl-overview-nav .fl-btn {padding-inline:9px}
}
.dsh-fleet-control .fl-root-ticket {grid-template-columns:108px 86px minmax(0,1fr) minmax(80px,130px) 72px 96px;gap:12px}
.dsh-fleet-control .fl-root-ticket .fl-st,.dsh-fleet-control .fl-root-workspace {display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-fleet-control .fl-root-ticket .fl-st .fl-dot {margin-inline-end:7px;vertical-align:middle}
.dsh-fleet-control .fl-root-group + .fl-root-group .fl-ghead {border-top:1px solid var(--fl-border)}
.dsh-fleet-control .fl-ghead h2 {font:inherit}
.dsh-fleet-control .fl-root-section-title {margin:26px 0 16px}
.dsh-fleet-control .fl-root-settings-row {display:grid;grid-template-columns:minmax(0,1fr) 112px minmax(125px,auto);gap:12px;align-items:center;padding:10px 16px}
.dsh-fleet-control .fl-root-settings-row + .fl-root-settings-row {border-top:1px solid var(--fl-border)}
.dsh-fleet-control .fl-root-settings-row h3 {overflow-wrap:anywhere}
.dsh-fleet-control .fl-root-settings-actions {justify-content:flex-end}
.dsh-fleet-control :is(.fl-st,.fl-dot)[data-tone=waiting] {color:var(--fl-waiting)}
.dsh-fleet-control :is(.fl-st,.fl-dot)[data-tone=danger] {color:var(--fl-danger)}
.dsh-fleet-control :is(.fl-st,.fl-dot)[data-tone=running] {color:var(--fl-running)}
.dsh-fleet-control :is(.fl-st,.fl-dot)[data-tone=success] {color:var(--fl-success)}
@container fleet (max-width:1000px) {
  .dsh-fleet-control .fl-cal-mwrap {display:flex}
}
@container ticket-list (max-width:860px) {
  .dsh-fleet-control .fl-root-ticket {grid-template-columns:92px minmax(0,1fr) minmax(80px,130px) 72px;gap:8px}
}
@container fleet (max-width:700px) {
  .dsh-fleet-control .fl-root-ticket {grid-template-columns:94px minmax(0,1fr) minmax(76px,112px);gap:8px;padding:5px 12px;min-height:44px;height:auto}
  .dsh-fleet-control .fl-root-ticket :is(.fl-id,.fl-pips,.fl-upd) {display:none}
}
@container fleet (max-width:460px) {
  .dsh-fleet-control .fl-root-ticket {grid-template-columns:minmax(0,1fr) minmax(76px,112px)}
  .dsh-fleet-control .fl-root-ticket .fl-ttl {grid-column:1/-1;grid-row:1}
  .dsh-fleet-control .fl-metrics.fl-strip {row-gap:8px}
  .dsh-fleet-control .fl-strip .fl-metric:nth-child(3) {border-left:0;padding-left:0}
  .dsh-fleet-control .fl-root-settings-row {grid-template-columns:minmax(0,1fr) auto}
  .dsh-fleet-control .fl-root-settings-row .fl-control-info {grid-column:1/-1}
}
`;
