import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// Isolated real-DOM fixture. No DSH URL, account, profile or plugin state is used.
const source = await readFile(new URL('../packages/fleet-shell/src/fleet-workspace-nav.js', import.meta.url), 'utf8');
const script = source.replace('export function mountWorkspaceDashboardLinks(', 'window.mountWorkspaceDashboardLinks = function mountWorkspaceDashboardLinks(');
let browser;
before(async () => {
  const executablePath = process.env.FLEET_TEST_BROWSER;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
});
after(async () => { await browser?.close(); });

const html = `<!doctype html><html><head><style>body{margin:0;font-family:Arial}#sidebar{width:280px}button{min-height:28px}</style></head><body>
<aside id="sidebar"><button id="before">Before</button><div role="tree" aria-label="Workspaces">
<div style="--dsh-workspace-indent:0px" id="group-alpha"><div class="native-hover-anchor"><div role="treeitem" aria-expanded="true" data-row-key="workspace:alpha"><span>Alpha</span></div></div>
<div role="group"><div style="--dsh-workspace-indent:12px" id="group-nested"><div role="treeitem" aria-expanded="true" data-row-key="workspace:nested">Nested</div></div></div>
<button role="treeitem" data-row-key="session:one" id="native-session">Native session</button></div>
<div style="--dsh-workspace-indent:0px" id="group-empty"><div role="treeitem" aria-expanded="true" data-row-key="workspace:empty">Empty</div></div>
<div style="--dsh-workspace-indent:0px" id="group-collapsed"><div role="treeitem" aria-expanded="false" data-row-key="workspace:collapsed">Collapsed</div></div>
<div style="--dsh-workspace-indent:0px" id="group-disabled"><div role="treeitem" aria-expanded="true" data-row-key="workspace:disabled">Disabled</div></div>
<div style="--dsh-workspace-indent:0px"><div role="treeitem" aria-expanded="true" data-row-key="workspace:">Ungrouped</div></div>
</div><button id="after">After</button></aside><main id="chat"><div contenteditable="true" id="composer">Unsent draft</div></main>
</body></html>`;

async function fixture(t) {
  const page = await browser.newPage();
  t.after(async () => { await page.close(); });
  await page.setContent(html);
  await page.addScriptTag({content:script});
  await page.evaluate(() => {
    window.initialSidebar = document.querySelector('#sidebar').innerHTML;
    window.originalComposer = document.querySelector('#composer');
    window.originalSession = document.querySelector('#native-session');
    window.opened = [];
    window.nativeBubbles = 0;
    document.querySelector('#sidebar').addEventListener('click', () => window.nativeBubbles++);
    window.listeners = new Set();
    window.stateReads = 0;
    window.state = {
      workspaces:['alpha','nested','empty','collapsed','disabled'].map(id => ({workspaceId:id,label:id.toUpperCase()})),
      enabledWorkspaceIds:['alpha','nested','empty','collapsed'],
      activeWorkspaceId:null
    };
    window.options = {
      root:document.querySelector('#sidebar'),
      getState:() => { window.stateReads++; return window.state; },
      subscribe:callback => { window.listeners.add(callback); return () => window.listeners.delete(callback); },
      onOpen:id => { window.opened.push(id); }
    };
    window.notify = patch => { Object.assign(window.state,patch); for (const listener of window.listeners) listener(); };
    window.dispose = window.mountWorkspaceDashboardLinks(window.options);
  });
  return page;
}
const entries = page => page.locator('[data-fleet-workspace-entry]');
const entry = (page,id) => page.locator(`[data-fleet-workspace-entry="${id}"]`);
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));

test('expanded workspaces including empty and nested get one owned Dashboard button', async t => {
  const page = await fixture(t);
  assert.equal(await entries(page).count(),3);
  assert.equal(await entry(page,'alpha').locator('button').getAttribute('aria-label'),'oh-my-dsh-fleet Dashboard · ALPHA');
  assert.equal(await entry(page,'alpha').getAttribute('aria-level'),'2');
  assert.equal(await entry(page,'nested').getAttribute('aria-level'),'3');
  assert.equal(await page.evaluate(() => document.querySelector('#group-alpha').firstElementChild.nextElementSibling.dataset.fleetWorkspaceEntry),'alpha');
  assert.equal(await entries(page).locator('[data-row-key]').count(),0);
  assert.equal(await page.locator('[data-fleet-workspace-entry][data-row-key]').count(),0);
  assert.equal(await page.locator('[data-row-key]').count(),7);
});

test('mouse, Enter, Space and Tab activate only the Dashboard callback', async t => {
  const page = await fixture(t);
  const button = entry(page,'alpha').locator('button');
  await page.locator('#before').focus();
  await page.keyboard.press('Tab');
  assert.equal(await button.evaluate(el => el === document.activeElement),true);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await button.click();
  assert.deepEqual(await page.evaluate(() => window.opened),['alpha','alpha','alpha']);
  assert.equal(await page.evaluate(() => window.nativeBubbles),0);
  assert.equal(await page.evaluate(() => window.originalComposer === document.querySelector('#composer')),true);
  assert.equal(await page.locator('#composer').innerText(),'Unsent draft');
});

test('collapse, expand, empty-group replacement and native reorder reconcile the owned row', async t => {
  const page = await fixture(t);
  await page.locator('[data-row-key="workspace:empty"]').evaluate(el => el.setAttribute('aria-expanded','false'));
  await settle(page);
  assert.equal(await entry(page,'empty').count(),0);
  await page.locator('[data-row-key="workspace:empty"]').evaluate(el => el.setAttribute('aria-expanded','true'));
  await settle(page);
  assert.equal(await entry(page,'empty').count(),1);
  await page.locator('#group-empty').evaluate(el => { el.innerHTML='<div role="treeitem" aria-expanded="true" data-row-key="workspace:empty">Empty replaced</div>'; });
  await settle(page);
  assert.equal(await entry(page,'empty').count(),1);
  await page.evaluate(() => document.querySelector('[role="tree"]').prepend(document.querySelector('#group-empty')));
  await settle(page);
  assert.equal(await entries(page).first().getAttribute('data-fleet-workspace-entry'),'empty');
  assert.equal(await page.evaluate(() => window.originalSession === document.querySelector('#native-session')),true);
});

test('workspace modes, rename, selection and removal use the subscribed live snapshot', async t => {
  const page = await fixture(t);
  await page.evaluate(() => window.notify({enabledWorkspaceIds:['alpha','disabled'],activeWorkspaceId:'alpha'}));
  await settle(page);
  assert.equal(await entries(page).count(),2);
  assert.equal(await entry(page,'alpha').locator('button').getAttribute('aria-current'),'page');
  await page.evaluate(() => window.notify({workspaces:window.state.workspaces.map(w => w.workspaceId === 'alpha' ? {...w,label:'Renamed'} : w)}));
  await settle(page);
  assert.equal(await entry(page,'alpha').locator('button').getAttribute('title'),'oh-my-dsh-fleet Dashboard · Renamed');
  await page.evaluate(() => window.notify({workspaces:window.state.workspaces.filter(w => w.workspaceId !== 'alpha')}));
  await settle(page);
  assert.equal(await entry(page,'alpha').count(),0);
});

test('flat/search and archived-only tree replacement remove stale entries and restore on return', async t => {
  const page = await fixture(t);
  await page.evaluate(() => {
    window.nativeTree = document.querySelector('[role="tree"]');
    window.flat = document.createElement('div'); window.flat.setAttribute('role','tree');
    window.flat.innerHTML='<button data-row-key="session:flat" role="treeitem">Flat result</button>';
    window.nativeTree.replaceWith(window.flat);
  });
  await settle(page);
  assert.equal(await entries(page).count(),0);
  await page.evaluate(() => window.flat.replaceWith(window.nativeTree));
  await settle(page);
  assert.equal(await entries(page).count(),3);
});

test('observer is sidebar-scoped and never writes native node attributes', async t => {
  const page = await fixture(t);
  await settle(page);
  const reads = await page.evaluate(() => window.stateReads);
  await page.locator('#chat').evaluate(el => { for (let i=0;i<30;i++) el.append(document.createElement('span')); });
  await settle(page);
  assert.equal(await page.evaluate(() => window.stateReads),reads);
  assert.deepEqual(await page.locator('[data-row-key="workspace:alpha"]').evaluate(el => Object.fromEntries([...el.attributes].map(a => [a.name,a.value]))),{role:'treeitem','aria-expanded':'true','data-row-key':'workspace:alpha'});
  await page.evaluate(() => window.dispose());
  assert.equal(await page.locator('#sidebar').innerHTML(),await page.evaluate(() => window.initialSidebar));
  assert.equal(await page.locator('style[data-fleet-workspace-nav-style]').count(),0);
  assert.equal(await page.evaluate(() => window.listeners.size),0);
});

test('duplicate mounts share nodes and final idempotent disposal stops every listener', async t => {
  const page = await fixture(t);
  await page.evaluate(() => { window.disposeSecond=window.mountWorkspaceDashboardLinks(window.options); window.dispose(); window.dispose(); });
  assert.equal(await entries(page).count(),3);
  assert.equal(await page.evaluate(() => window.listeners.size),1);
  await page.evaluate(() => { window.disposeSecond(); window.disposeSecond(); });
  assert.equal(await entries(page).count(),0);
  await page.locator('[data-row-key="workspace:empty"]').evaluate(el => el.setAttribute('aria-expanded','false'));
  await page.evaluate(() => window.notify({activeWorkspaceId:'alpha'}));
  await settle(page);
  assert.equal(await entries(page).count(),0);
  assert.equal(await page.evaluate(() => window.listeners.size),0);
  assert.equal(await page.locator('style[data-fleet-workspace-nav-style]').count(),0);
});
