// Real React + generated production Client, isolated loopback API + real FleetService.
// Usage: node scripts/review-fleet-ui.mjs [--serve] [--edge C:\path\msedge.exe]
// No DSH process, installed Profile, Desktop port, or production model is accessed.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { createFleetUIFixture, removeOwnedTemp } from './fixtures/fleet-ui-server.mjs';
import { FleetStore } from '../src/fleet-store.js';
import { projectTicket } from '../src/fleet-model.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const packageVersion = JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')).version;
const output = path.join(repository, `.artifacts/fleet-ui-${packageVersion}`);
const args = process.argv.slice(2);
const edge = args.includes('--edge') ? args[args.indexOf('--edge') + 1] : path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe');
const sourceFiles = ['client.js', 'src/fleet-client.js', 'src/fleet-locale.js', 'src/fleet-workspace-nav.js', 'src/fleet-ui.js', 'src/fleet-theme.js', 'src/fleet-dashboard-api.js', 'src/fleet-service.js', 'src/fleet-core.js', 'src/fleet-store.js'];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await fs.readFile(path.join(repository, file))).digest('hex')])));
const fixture = await createFleetUIFixture();
const readTicket=(...args)=>fixture.service.read(...args).then(result=>Array.isArray(result)?result.map(ticket=>projectTicket(ticket)):projectTicket(result));
if (args.includes('--serve')) {
  console.log(JSON.stringify({ mode: 'isolated-fixture', origin: fixture.origin, rootPath: fixture.rootPath, note: 'Temporary fixture only. Ctrl+C closes the service and removes its temporary state.' }));
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await fixture.close(); process.exit(0); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
} else {
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-ui-edge-'));
  const report = {
    schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running',
    boundary: {
      browser: 'Independent headless Edge with a new temporary profile',
      react: 'Installed React 19.2.0 and react-dom 19.2.0 production CJS, wrapped for browser require without source transformation',
      client: 'Unmodified generated client.js through its real __ModuleLoader__ factory',
      api: 'Actual registerFleetDashboardApi handlers and one real FleetService/FleetCore/FleetStore writer',
      fixtures: ['Host workspaces/sessions/layout/locale/slots/hooks', 'Native Conversation remount/session/draft simulation', 'Workspace mode endpoint', 'Execution adapter with deterministic session outputs', 'Seed plans in temporary Root and Workspace directories', 'Explicit one-shot transport failures for retry checks', 'Deterministic scheduler tick after accepted HTTP actions'],
      desktopAcceptance: false, existingDSHAccessed: false, desktopProfileAccessed: false,
      modelCalls: false, origin: fixture.origin, temporaryRoot: fixture.temp
    }, sourceHashes, checks: [], screenshots: [], console: [], pageErrors: [], blockedRequests: [], networkFailures: []
  };
  let context, page;
  const check = async (name, operation) => {
    const start = Date.now();
    try { const evidence = await operation(); report.checks.push({ name, status: 'passed', milliseconds: Date.now() - start, ...(evidence === undefined ? {} : { evidence }) }); console.log(`PASS ${name}`); return true; }
    catch (error) {
      report.checks.push({ name, status: 'failed', milliseconds: Date.now() - start, error: error.stack ?? String(error) }); console.error(`FAIL ${name}: ${error.message}`);
      // Recover an open modal so one failure does not hide independent checks.
      if (page) { try { if (await page.locator('dialog[open]').count()) await page.keyboard.press('Escape'); } catch {} }
      return false;
    }
  };
  const screenshot = async name => { await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true }); report.screenshots.push(`${name}.png`); };
  const snapshot = () => page.evaluate(() => window.__fleetFixture.snapshot());
  const dashboardReady = async () => {
    await page.locator('[data-fleet-tab="overview"]').waitFor();
    await page.locator('.fl-loading').waitFor({ state: 'hidden' });
    await page.locator('.fl-head button').first().waitFor();
  };
  const openWorkspace = async (id = 'alpha') => {
    await page.locator('[data-fixture-control]').click();
    await page.locator('[data-fleet-root-tab="settings"]').click();
    await page.locator(`[data-fleet-open="${id}"]`).click();
    await dashboardReady();
    await page.locator(`[data-fleet-panel-workspace-id="${id}"]`).waitFor();
  };
  const tab = async name => { await page.locator(`[data-fleet-tab="${name}"]`).click(); };
  const ticket = async id => {
    await tab('tickets');
    await page.getByRole('searchbox').fill('');
    await page.getByRole('combobox', { name: '任务状态', exact: true }).selectOption('all');
    await page.locator(`[data-open-ticket="${id}"]`).click();
    await page.locator('.fl-workbench').waitFor();
  };
  const refresh = async () => {
    const response = page.waitForResponse(r => r.url().includes('/api/fleet/view') && r.request().method() === 'GET');
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await response; await page.locator('.fl-loading').waitFor({ state: 'hidden' });
  };
  const action = async (name, click, {keepsEditorOpen=name==='draft-save'}={}) => {
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/api/fleet/action') && r.request().postDataJSON()?.action === name), click()
    ]);
    const body = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(body));
    if(keepsEditorOpen)await page.locator('dialog [data-fleet-draft-state="saved"]').waitFor();
    else await page.locator('dialog').waitFor({ state: 'hidden' });
    return body;
  };
  const value = async (locator, expected) => { await locator.waitFor(); assert.equal(await locator.inputValue(), expected); };
  const sharedSnapshot = async () => (await readTicket('alpha', 'running')).snapshot;
  try {
    context = await chromium.launchPersistentContext(profile, { executablePath: edge, headless: true, viewport: { width: 1365, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', args: ['--no-first-run', '--disable-sync', '--disable-background-networking', '--disable-component-update'] });
    await context.route('**/*', route => { const url = route.request().url(); if (url.startsWith(fixture.origin + '/')) return route.continue(); report.blockedRequests.push(url); return route.abort('blockedbyclient'); });
    page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('console', event => { if (['warning', 'error'].includes(event.type())) report.console.push({ type: event.type(), text: event.text(), location: event.location() }); });
    page.on('pageerror', error => report.pageErrors.push(error.stack ?? error.message));
    page.on('requestfailed', request => report.networkFailures.push({ url: request.url(), error: request.failure()?.errorText }));
    await page.goto(fixture.origin, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__fleetFixture?.ready);
    await check('real React and generated Client register additive panels', async () => {
      assert.equal(await page.evaluate(() => window.__fleetFixture.reactVersion), '19.2.0');
      const state = await snapshot();
      assert.deepEqual(state.registeredSlots.map(s => s.name).sort(), ['conversation.view', 'main', 'main', 'sidebar.panellist', 'sidebar.right.pane.tab']);
      assert.deepEqual(state.conversationViews, ['oh-my-dsh-fleet'], 'Fleet registers exactly one conversation view with its own id');
      assert.equal(state.native.sessionId, 'native-original');
      return { reactVersion: '19.2.0', slots: state.registeredSlots };
    });
    await check('seed states are produced by real FleetService and store', async () => {
      assert.equal(fixture.seed.alpha.find(t => t.id === 'draft').execution, null);
      assert.equal(fixture.seed.alpha.find(t => t.id === 'delivered').status, 'delivered');
      assert.equal(fixture.seed.alpha.find(t => t.id === 'failed').execution.nodes.build.status, 'failed');
      assert.equal(fixture.seed.alpha.find(t => t.id === 'waiting').execution.gates.quality.status, 'pending');
      assert.equal(fixture.seed.alpha.find(t => t.id === 'returned').execution.gates.quality.reviews[0].decision, 'returned');
      assert.equal(fixture.seed.alpha.find(t => t.id === 'stale').status, 'running', 'stale coverage blocks delivered');
      assert.equal(fixture.seed.alpha.find(t => t.id === 'evidence').status, 'running');
      assert.ok(fixture.seed.alpha.find(t => t.id === 'delivered').execution.delivery.history.length > 0, 'delivered seed exported a real delivery');
      assert(fixture.seed.alpha.every(t=>t.plan.contractVersion===3&&!Object.hasOwn(t,'snapshot')&&!Object.hasOwn(t,'nodes')),'seed service reads stay canonical');
      return fixture.seed.alpha.map(t => ({ id: t.id, status: t.status, nodes: Object.values(t.execution?.nodes??{}).map(n => n.status), gates: Object.values(t.execution?.gates??{}).map(g => g.status) }));
    });
    await check('Workspace selection opens panel without navigating Session', async () => {
      await page.getByRole('textbox', { name: 'Native draft', exact: true }).fill('native draft preserved across Fleet');
      const before = await snapshot(); await openWorkspace('alpha'); const after = await snapshot();
      assert.equal(after.native.sessionId, before.native.sessionId);
      assert.equal(after.calls.filter(c => c.kind === 'session' || c.kind === 'new-session').length, 0);
      assert(after.nativeUnmounts > before.nativeUnmounts);
    });
    await check('return remounts simulated native Conversation and retains draft', async () => {
      await page.getByRole('button', { name: '返回对话', exact: true }).click();
      await value(page.getByRole('textbox', { name: 'Native draft', exact: true }), 'native draft preserved across Fleet');
      assert.equal((await snapshot()).native.sessionId, 'native-original'); await openWorkspace('alpha');
    });

    // Every visible Fleet page, both palettes, three viewport widths.
    const pages = ['overview', 'tickets', 'ticket', 'agents', 'agent', 'orchestrations', 'orchestration', 'binding', 'control'];
    async function show(name) {
      if (name === 'control') { await page.locator('[data-fixture-control]').click(); await page.locator('[data-fleet-control]').waitFor(); return; }
      if (!await page.locator('[data-fleet-tab="overview"]').count()) await openWorkspace('alpha');
      if (name === 'ticket') await ticket('running');
      else if (name === 'agent') { await tab('agents'); await page.locator('[data-fleet-agent="writer"]').getByRole('button').click(); }
      else if (name === 'orchestration') { await tab('orchestrations'); await page.getByRole('button', { name: '查看编排 ↗', exact: true }).first().click(); }
      else await tab(name);
      await page.locator('.fl-loading').waitFor({ state: 'hidden' });
    }
    for (const width of [1365, 800, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => window.__fleetFixture.theme(theme), theme);
        for (const name of pages) await check(`layout ${name} ${theme} ${width}: no root horizontal overflow`, async () => {
          await show(name);
          const metrics = await page.evaluate(() => {
            const shell = document.querySelector('.dsh-fleet-shell');
            return { root: document.documentElement.scrollWidth, viewport: innerWidth, shell: shell?.clientWidth, shellScroll: shell?.scrollWidth, background: getComputedStyle(shell).backgroundColor, foreground: getComputedStyle(shell).color };
          });
          assert(metrics.root <= metrics.viewport + 1, JSON.stringify(metrics));
          assert(metrics.shellScroll <= metrics.shell + 1, JSON.stringify(metrics));
          assert.notEqual(metrics.background, metrics.foreground);
          if (width === 1365 && ['overview', 'ticket'].includes(name)) await screenshot(`${name}-${theme}`);
          if (width === 1365 && theme === 'light' && ['agents', 'orchestration', 'control'].includes(name)) await screenshot(name === 'orchestration' ? 'flow' : name);
          if (width === 390 && theme === 'light' && name === 'ticket') await screenshot('390');
          if (width === 800 && theme === 'dark' && name === 'overview') await screenshot('overview-800');
          return metrics;
        });
      }
    }
    await check('390px Ticket navigation resets only Fleet scroll and Node controls remain usable', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => window.__fleetFixture.theme('light'));
      await openWorkspace('alpha'); await ticket('running');
      await page.waitForFunction(() => document.querySelector('.dsh-fleet-shell')?.scrollTop === 0);
      await page.locator('[data-fleet-node="ship"]').click(); await page.locator('[data-fleet-thread="ship"]').waitFor();
      await page.locator('[data-fleet-node="build"]').click(); await page.locator('[data-fleet-thread="build"]').scrollIntoViewIfNeeded();
      await screenshot('390-thread');
    });
    await page.setViewportSize({ width: 1365, height: 1000 });
    await page.evaluate(() => window.__fleetFixture.theme('light'));
    await openWorkspace('alpha');
    await check('Tickets search by goal and ID and status filtering', async () => {
      await tab('tickets'); await page.getByRole('searchbox').fill('upstream-no-result');
      await page.getByText('没有匹配的任务', { exact: true }).waitFor();
      await page.getByRole('searchbox').fill('failed'); assert.equal(await page.locator('[data-fleet-ticket]').count(), 1);
      assert.equal(await page.locator('[data-fleet-ticket]').getAttribute('data-fleet-ticket'), 'failed');
      await page.getByRole('searchbox').fill('连接失败'); assert.equal(await page.locator('[data-fleet-ticket]').count(), 1);
      assert.equal(await page.locator('[data-fleet-ticket]').getAttribute('data-fleet-ticket'), 'failed');
      await page.getByRole('searchbox').fill(''); await page.getByRole('combobox', { name: '任务状态', exact: true }).selectOption('draft');
      assert.deepEqual((await page.locator('[data-fleet-ticket]').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-fleet-ticket')))).sort(), ['clarity', 'draft']);
      await page.getByRole('combobox', { name: '任务状态', exact: true }).selectOption('all');
    });
    await check('dialog native focus containment and Escape return focus', async () => {
      await ticket('draft');
      const opener = page.getByRole('button', { name: '修改草稿', exact: true });
      await opener.focus(); await page.keyboard.press('Enter'); await page.getByRole('dialog').waitFor();
      assert(await page.evaluate(() => document.querySelector('dialog').matches(':modal') && document.querySelector('dialog').contains(document.activeElement)));
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('Tab');
        // Edge can focus its browser chrome at the end of the native modal cycle;
        // activeElement is then BODY. No underlying page control may gain focus.
        assert(await page.evaluate(() => document.activeElement === document.body || document.querySelector('dialog').contains(document.activeElement)));
      }
      await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert(await opener.evaluate(element => element === document.activeElement));
    });
    let created;
    await check('create entrance opens native command draft without modal or Ticket creation', async () => {
      const calls = fixture.host.calls.filter(c => c.method === 'create').length;
      const ticketsBefore=(await readTicket('alpha')).length;
      await page.getByRole('button', { name: '新建任务', exact: true }).first().click();
      await page.locator('[data-native-conversation]').waitFor();
      await value(page.getByRole('textbox',{name:'Native draft'}),'/fleet new ');
      assert.equal(await page.getByRole('dialog').count(),0);
      assert.equal((await readTicket('alpha')).length,ticketsBefore);
      assert.equal(fixture.host.calls.filter(c => c.method === 'create').length, calls);
      // Existing prepared fixture is used only for legacy revise/start regression below.
      created='draft';
      await openWorkspace('alpha');
      return { newTicketCount:0, executionSessions:0 };
    });
    await check('revise updates the same draft without creating a Session', async () => {
      assert(created, 'prepare prerequisite'); await ticket(created);
      const before = fixture.host.calls.filter(c => c.method === 'create').length;
      const ticketsBefore = (await readTicket('alpha')).length;
      await page.getByRole('button', { name: '修改草稿', exact: true }).click();
      await page.locator('dialog .fl-eblock').first().click();
      await page.locator('dialog textarea[name="goal"]').fill('浏览器修订后的确认前草稿');
      await action('draft-save', () => page.getByRole('dialog').getByRole('button', { name: '应用', exact: true }).click());
      await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
      const revised = await readTicket('alpha', created);
      assert.equal(revised.goal, '浏览器修订后的确认前草稿'); assert.equal(revised.status, 'draft'); assert.equal(revised.snapshot, null);
      assert.equal((await readTicket('alpha')).length, ticketsBefore); assert.equal(fixture.host.calls.filter(c => c.method === 'create').length, before);
    });
    await check('the shared editor inside the revise dialog exposes the start button', async () => {
      assert(created, 'prepare prerequisite'); await ticket(created);
      await page.getByRole('button', { name: '修改草稿', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('[data-fleet-draft-start]').waitFor();
      assert.equal(await dialog.locator('[data-fleet-draft-start]').isDisabled(), false, 'valid saved draft enables the editor start button');
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    });
    await check('start requires confirmation then freezes snapshot and executes', async () => {
      assert(created, 'prepare prerequisite'); await ticket(created);
      await page.getByRole('button', { name: '确认并启动', exact: true }).click();
      assert.equal((await readTicket('alpha', created)).status, 'draft');
      await page.getByRole('dialog').getByText('启动会保存当前定义快照，并开始调用智能体。', { exact: true }).waitFor();
      await action('start', () => page.getByRole('dialog').getByRole('button', { name: '确认并启动', exact: true }).click());
      const started = await readTicket('alpha', created); assert.equal(started.status, 'running'); assert(started.snapshot); assert(started.nodes[0].attempts[0].sessionId);
    });
    await check('node selection changes thread and explicit Session opening', async () => {
      await ticket('running'); await page.locator('[data-fleet-node="ship"]').click(); await page.locator('[data-fleet-thread="ship"]').waitFor();
      await page.locator('[data-fleet-node="build"]').click(); const sessionId = (await readTicket('alpha', 'running')).nodes[0].attempts.at(-1).sessionId;
      await page.locator(`[data-fleet-node-session="${sessionId}"]`).click(); await page.locator(`[data-native-session="${sessionId}"]`).waitFor();
      assert.equal((await snapshot()).calls.filter(c => c.kind === 'session').at(-1).id, sessionId); await openWorkspace('alpha');
    });
    await check('shared surface stacks in narrow containers and pairs canvas with node settings in wide ones', async () => {
      const original=page.viewportSize();
      try {
        const rects=async()=>page.locator('.fl-workbench').evaluate(el=>{
          const canvas=el.querySelector('.fl-flow').closest('section').getBoundingClientRect();
          const settings=el.querySelector('[data-fleet-thread]').getBoundingClientRect();
          return {canvas,settings};
        });
        await page.setViewportSize({width:1440,height:900});
        await ticket('running');
        let r=await rects();
        assert(Math.abs(r.settings.top-r.canvas.top)<48&&r.settings.left>r.canvas.left,JSON.stringify(r),'wide layout puts node settings beside the canvas');
        await page.setViewportSize({width:820,height:900});
        await page.waitForTimeout(120);
        r=await rects();
        assert(Math.abs(r.settings.left-r.canvas.left)<4&&r.settings.top>r.canvas.bottom-1,JSON.stringify(r),'narrow layout stacks settings under the canvas');
        assert.equal(await page.locator('[data-fleet-open-dashboard]').count(),0,'fullscreen panel crumb keeps 中控台/返回对话, not the tab jump');
      } finally {await page.setViewportSize(original); await openWorkspace('alpha');}
    });
    await check('canvas wheel zooms without moving the ticket in embedded and fullscreen views', async () => {
      await ticket('running');
      for (const full of [false,true]) {
        if(full) await page.getByRole('button',{name:'放大查看 ⤢'}).click();
        const canvas=page.locator('.fl-flow');
        await canvas.scrollIntoViewIfNeeded();
        await canvas.hover();
        const scroll=()=>canvas.evaluate(el=>{const offsets=[];for(let n=el.parentElement;n;n=n.parentElement)offsets.push(n.scrollTop);return offsets;});
        const before=await scroll(), zoom=await page.locator('.fl-flowctl .fl-mono').textContent();
        await page.mouse.wheel(0,Number.parseInt(zoom)>45?100:-100);
        await page.waitForFunction(z=>document.querySelector('.fl-flowctl .fl-mono')?.textContent!==z,zoom);
        await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
        assert.deepEqual(await scroll(),before);
      }
      await page.keyboard.press('Escape');
    });
    await check('draft entry is the Tab only; the sidebar resource renders the shared Ticket detail responsively', async () => {
      assert.equal(await page.locator('[data-fleet-reopen-draft]').count(), 0, 'title-side draft button is removed');
      assert.equal((await snapshot()).calls.filter(c => c.kind === 'resource').length, 0, 'no draft resource auto-opens');
      await page.evaluate(() => window.__fleetFixture.openSession('seed'));
      await page.evaluate(() => window.__fleetFixture.openResource('dsh-resource://fleet-ticket-draft/alpha/seed/clarity'));
      const pane = page.locator('[data-fleet-side-pane]');
      await pane.waitFor();
      await pane.locator('[data-fleet-ticket-card="clarity"]').waitFor();
      assert.equal(await pane.locator('[data-fleet-tab]').count(), 0, 'side pane hides workspace tabs');
      assert.equal(await pane.getByRole('button', { name: '← 任务', exact: true }).count(), 0, 'side pane hides the back-to-list button');
      await pane.getByRole('button', { name: '修改草稿', exact: true }).waitFor();
      await pane.getByRole('button', { name: '确认并启动', exact: true }).waitFor();
      const metrics = await pane.evaluate(el => { const shell = el.closest('.dsh-fleet-shell'); return { shell: shell.clientWidth, scroll: shell.scrollWidth, width: el.getBoundingClientRect().width }; });
      assert(metrics.scroll <= metrics.shell + 1, JSON.stringify(metrics));
      assert(metrics.width <= 561, JSON.stringify(metrics), 'detail renders inside the 560px sidebar');
      await screenshot('side-pane-ticket');
      await pane.getByRole('button', { name: '修改草稿', exact: true }).click();
      await page.locator('dialog [data-fleet-draft-state]').waitFor();
      await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
      await page.locator('dialog').waitFor({ state: 'hidden' });
      await page.locator('[data-fixture-close-draft]').click();
      await pane.waitFor({ state: 'detached' });
      await openWorkspace('alpha');
      return metrics;
    });
    await check('flow drag suppresses text selection and every interrupted gesture releases panning', async () => {
      await ticket('running');
      const canvas = page.locator('.fl-flow');
      await canvas.scrollIntoViewIfNeeded();
      const box = await canvas.boundingBox();
      const transform = () => page.locator('.fl-flow-inner').evaluate(el => el.style.transform);
      const drag = async interrupt => {
        await page.mouse.move(box.x + 6, box.y + box.height - 28);
        await page.mouse.down();
        await page.mouse.move(box.x + 26, box.y + box.height - 32, { steps: 8 });
        assert.equal(await canvas.getAttribute('data-drag'), 'true');
        assert.equal(await page.evaluate(() => getSelection().toString()), '', 'panning must not select node text');
        const moved = await transform();
        if (interrupt === 'cancel') await canvas.dispatchEvent('pointercancel', { pointerId: 1, bubbles: true });
        else if (interrupt === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        else await page.mouse.up();
        if (interrupt) await page.mouse.up();
        await page.waitForFunction(() => document.querySelector('.fl-flow').dataset.drag === 'false');
        await page.mouse.move(box.x + 220, box.y + 150, { steps: 4 });
        assert.equal(await transform(), moved, `${interrupt}: later moves must not keep panning`);
        await page.waitForTimeout(25);
      };
      for (const interrupt of [null, 'cancel', 'blur']) await drag(interrupt);
      await page.locator('[data-fleet-node="ship"]').click();
      await page.locator('[data-fleet-thread="ship"]').waitFor();
      assert.notEqual(await page.locator('[data-fleet-ticket-title="running"]').evaluate(el => getComputedStyle(el).userSelect), 'none', 'Ticket prose stays selectable');
      return { endings: ['pointerup', 'pointercancel', 'window-blur'], selection: 'empty', nodeClick: 'ship' };
    });
    await check('stop settles real adapter work and resume starts a new attempt', async () => {
      await ticket('running'); const before = await readTicket('alpha', 'running');
      await action('stop', () => page.getByRole('button', { name: '停止任务', exact: true }).click());
      assert.equal((await readTicket('alpha', 'running')).status, 'stopped');
      await page.getByRole('button', { name: '恢复执行', exact: true }).waitFor();
      await action('resume', () => page.getByRole('button', { name: '恢复执行', exact: true }).click());
      const after = await readTicket('alpha', 'running'); assert.equal(after.status, 'running'); assert(after.nodes[0].attempts.length > before.nodes[0].attempts.length); assert.deepEqual(after.execution.configurations[before.execution.currentConfigRevision],before.execution.configurations[before.execution.currentConfigRevision]);
    });
    await check('failed node retry retains the failed attempt and starts a new Session', async () => {
      await ticket('failed'); const before = await readTicket('alpha', 'failed');
      await page.locator('[data-fleet-blocker-retry]').click();
      await page.getByRole('textbox', { name: '重试原因', exact: true }).fill('浏览器已核对错误，重新执行并保留证据。');
      await action('retry', () => page.getByRole('dialog').getByRole('button', { name: '确认保存', exact: true }).click());
      const after = await readTicket('alpha', 'failed');
      assert.equal(after.nodes[0].attempts.length, before.nodes[0].attempts.length + 1); assert.equal(after.nodes[0].attempts[0].status, 'failed'); assert.equal(after.nodes[0].status, 'running'); assert.deepEqual(after.snapshot, before.snapshot);
    });
    await check('running configuration is locked while stopped Ticket edits preserve earlier execution', async () => {
      await ticket('running'); await page.locator('[data-fleet-node="build"]').click();
      assert.equal(await page.getByRole('button',{name:'修改当前任务',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'修改草稿',exact:true}).count(),0);
      const catalog=await fixture.service.catalog();
      await action('stop',()=>page.getByRole('button',{name:'停止任务',exact:true}).click());
      const before=await readTicket('alpha','running');
      await page.getByRole('button',{name:'修改草稿',exact:true}).click();await page.locator('dialog .fl-eblock').first().click();
      await page.locator('dialog textarea[name="goal"]').fill('Stopped Ticket edited for subsequent execution');
      await action('draft-save',()=>page.getByRole('dialog').getByRole('button',{name:'应用',exact:true}).click());
      const after=await readTicket('alpha','running');assert.equal(after.id,before.id);assert.equal(after.status,'stopped');assert.equal(after.plan.goal,'Stopped Ticket edited for subsequent execution');assert.deepEqual(after.execution,before.execution);
      assert.deepEqual((await fixture.service.catalog()).templates,catalog.templates);
      await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
    });
    await check('human Gate pass retains returned review and provenance', async () => {
      await ticket('returned'); const before = await readTicket('alpha', 'returned');
      await page.locator('[data-fleet-gate-node="quality"]').click();
      await page.locator('[data-fleet-gate="quality"]').getByRole('button', { name: '人工通过', exact: true }).click();
      await page.getByRole('dialog').getByText(/原有和后续智能体审核意见继续保留/).waitFor();
      await action('pass', () => page.getByRole('dialog').getByRole('button', { name: '确认保存', exact: true }).click());
      const gate = (await readTicket('alpha', 'returned')).gates[0];
      assert.equal(gate.status, 'passed'); assert.deepEqual(gate.reviews, before.gates[0].reviews); assert.equal(gate.humanOverride.actor.userId, 'dsh-dashboard');
      await page.getByText('已记录人工覆盖', { exact: true }).waitFor();
    });
    await check('completion facts separate execution, self-reported evidence and acceptance', async () => {
      await ticket('evidence');
      await page.locator('[data-fleet-node="build"]').click();
      const facts = page.locator('[data-fleet-completion]');
      await facts.waitFor();
      const text = await facts.textContent();
      assert.ok(text.includes('已结束'), text);
      assert.ok(text.includes('已提交 · 自报'), text);
      assert.ok(text.includes('未通过'), text);
      const detail = await page.locator('[data-fleet-evidence-details]').first().textContent();
      assert.ok(detail.includes('The artifact contains a verifiable result.'), detail);
      assert.ok(detail.includes('fixture-check --report'), detail);
      assert.ok(!text.includes('未提交结构化证据'), text);
      await page.locator('[data-fleet-node="ship"]').click();
      await page.locator('[data-fleet-thread="ship"]').waitFor();
      assert.equal(await page.locator('[data-fleet-completion]').count(), 0, 'a node without an Attempt has no completion facts');
      await ticket('waiting');
      await page.locator('[data-fleet-node="build"]').click();
      await page.locator('[data-fleet-completion]').waitFor();
      assert.ok((await page.locator('[data-fleet-completion]').textContent()).includes('未提交结构化证据'));
      await screenshot('completion-facts');
    });
    await check('deliverable rows link latest version, review state and real /api/file location bytes', async () => {
      await ticket('delivered');
      const row = page.locator('[data-fleet-deliverable-row="0"]');
      await row.waitFor();
      const rowText = await row.textContent();
      assert.ok(rowText.includes('v1'), rowText);
      assert.ok(rowText.includes('已审核'), rowText);
      assert.ok(rowText.includes('已交付'), rowText);
      await page.locator('[data-fleet-deliverable-toggle="0"]').click();
      // Inline anchor is a real host /api/file link (never a fake button), and its bytes match the projection.
      const link = page.locator('[data-fleet-deliverable-link="0"]');
      const href = await link.getAttribute('href');
      assert.ok(href.startsWith('api/file?path='), href);
      assert.equal(await link.getAttribute('target'), '_blank');
      assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
      const projected = (await readTicket('alpha', 'delivered')).deliverables[0];
      const fileResponse = await page.request.get(fixture.origin + '/' + href);
      assert.equal(fileResponse.status(), 200);
      assert.equal(createHash('sha256').update(await fileResponse.body()).digest('hex'), projected.latest.sha256, 'sealed bytes match the projected sha256');
      assert.equal(fileResponse.headers()['x-content-type-options'], 'nosniff');
      await page.locator('[data-fleet-deliverable="0"]').click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      const body = await dialog.textContent();
      assert.ok(body.includes('版本历史'), body);
      assert.ok(body.includes('SHA-256'), body);
      assert.ok(body.includes('审核记录'), body);
      assert.ok(body.includes('交付记录'), body);
      for (const name of ['manifest.json', 'receipt.json']) {
        const recordHref = await dialog.locator(`a[href*="${name}"]`).first().getAttribute('href');
        assert.ok(recordHref && recordHref.startsWith('api/file?path='), `${name}: ${recordHref}`);
      }
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await ticket('waiting');
      const waitingRow = await page.locator('[data-fleet-deliverable-row="0"]').textContent();
      assert.ok(waitingRow.includes('未绑定'), waitingRow);
      assert.ok(waitingRow.includes('尚未提交产物'), waitingRow);
      assert.equal(await page.locator('[data-fleet-deliverable-link="0"]').count(), 0, 'unbound deliverables never render a fake location link');
      await screenshot('deliverables');
    });
    await check('stale coverage blocks delivery and human override releases it with recorded gaps', async () => {
      await ticket('stale');
      await page.locator('[data-fleet-gate-node="quality"]').click();
      const gate = page.locator('[data-fleet-gate="quality"]');
      await gate.waitFor();
      assert.ok((await gate.textContent()).includes('待复核'), await gate.textContent());
      assert.ok((await gate.textContent()).includes('产物已更新，审核结论未覆盖最新版本'), await gate.textContent());
      const blocked = page.locator('[data-fleet-delivery-blocked]');
      await blocked.waitFor();
      assert.ok((await blocked.textContent()).includes('quality'));
      assert.equal((await readTicket('alpha', 'stale')).status, 'running');
      await page.locator('[data-fleet-deliver-override]').click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      await dialog.getByRole('textbox', { name: '覆盖理由', exact: true }).fill('Fixture: release delivery with the stale review recorded.');
      await action('deliver-override', () => dialog.getByRole('button', { name: '确认保存', exact: true }).click());
      const after = await readTicket('alpha', 'stale');
      assert.equal(after.status, 'delivered');
      assert.equal(after.delivery.override.reason, 'Fixture: release delivery with the stale review recorded.');
      assert.ok(after.delivery.override.gaps.staleGates.includes('quality'));
      await page.locator('[data-fleet-delivery-override]').waitFor();
      assert.ok((await page.locator('[data-fleet-delivery-override]').textContent()).includes('Fixture: release delivery'));
      await screenshot('delivery-override');
    });
    await check('human review passed binds the latest artifact versions without override', async () => {
      await ticket('evidence');
      assert.equal(await page.locator('[data-fleet-gate-inspector]').count(),0);
      await page.locator('[data-fleet-review-subject="quality"]').click();
      const gate = page.locator('[data-fleet-gate="quality"]');
      await gate.waitFor();
      const gateText = await gate.textContent();
      assert.ok(gateText.includes('需要结构化证据'), gateText);
      assert.ok(gateText.includes('人工退回 · 返工无限次'), gateText);
      const artifactLink=gate.locator('[data-fleet-review-artifact]').first();
      const artifactId=await artifactLink.getAttribute('data-fleet-review-artifact');
      const subject=(await readTicket('alpha','evidence')).artifacts[artifactId];
      const href=await artifactLink.getAttribute('href');
      const response=await page.request.get(fixture.origin+'/'+href);
      assert.equal(response.status(),200);
      assert.equal(createHash('sha256').update(await response.body()).digest('hex'),subject.versions.at(-1).sha256);
      const beforeModel=await readTicket('alpha','evidence');
      await page.locator('[data-fleet-node="ship"]').click();
      const modelDialog=page.locator('[data-fleet-ticket-model="ship"]');
      await modelDialog.locator('[data-fleet-model-menu-trigger="seat"]').click();
      await modelDialog.locator('[data-fleet-model-row="effort"]').click();
      await action('node-model',()=>modelDialog.locator('[data-fleet-model-option="high"]').click(),{keepsEditorOpen:false});
      const afterModel=await readTicket('alpha','evidence');
      assert.equal(afterModel.status,'running');
      assert.deepEqual(afterModel.execution.nodes,beforeModel.execution.nodes);
      assert.deepEqual(afterModel.execution.gates,beforeModel.execution.gates);
      for(const [id,config] of Object.entries(beforeModel.execution.configurations))assert.deepEqual(afterModel.execution.configurations[id],config);
      await page.locator('[data-fleet-review-subject="quality"]').click();
      await page.locator('[data-fleet-todo-approve="quality"]').click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      assert.ok((await dialog.textContent()).includes('自动绑定最新产物版本'));
      await dialog.getByRole('textbox', { name: '审核证据', exact: true }).fill('Fixture: reviewed the latest sealed version.');
      await action('review', () => dialog.getByRole('button', { name: '确认保存', exact: true }).click());
      const after = await readTicket('alpha', 'evidence');
      const shipAttempt=after.execution.nodes.ship.attempts.at(-1);
       assert.deepEqual(shipAttempt.dispatch.detail.modelSelection,{provider:'fixture',model:'fixture-default',reasoningEffort:'high'});
       const g = after.gates.find(item => item.id === 'quality');
      assert.equal(g.status, 'passed');
      assert.equal(g.coverage, 'covered');
      assert.equal(g.humanOverride, null);
      const review = g.reviews.at(-1);
      assert.equal(review.decision, 'passed');
      assert.equal(review.bindingKind, 'auto-latest');
      assert.ok(review.artifactRefs.length > 0);
      await page.locator('[data-fleet-gate-coverage="quality"]').waitFor();
      assert.ok((await page.locator('[data-fleet-gate="quality"]').textContent()).includes('已审核'));
      await screenshot('review-passed');
    });
    await check('plan popouts show task contract, evidence requirement and rework policy', async () => {
      await ticket('evidence');
      await page.getByRole('button', { name: '查看计划', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      await dialog.locator('[data-fleet-draft-node="build"]').click();
      const contract = dialog.locator('[data-fleet-node-contract="build"]');
      await contract.waitFor();
      const contractText = await contract.textContent();
      assert.ok(contractText.includes('The artifact contains a verifiable result.'), contractText);
      assert.ok(contractText.includes('report/'), contractText);
      assert.ok(contractText.includes('fixture-check --report'), contractText);
      await dialog.locator('.fl-popout').getByRole('button', { name: '关闭', exact: true }).click();
      await dialog.locator('.fl-popout').waitFor({ state: 'hidden' });
      await dialog.locator('[data-fleet-draft-gate="quality"]').click();
      await page.waitForFunction(() => document.querySelector('dialog .fl-popout')?.textContent.includes('必须提交'));
      const gateText = await dialog.locator('.fl-popout').textContent();
      assert.ok(gateText.includes('开启 · 人工退回无限次'), gateText);
      assert.ok(gateText.includes('Only revise the delivered artifact.'), gateText);
      await dialog.getByRole('button', { name: '关闭', exact: true }).first().click();
      await dialog.waitFor({ state: 'hidden' });
    });
    await check('draft structural edits round-trip gate policy, task contract and delivery target', async () => {
      // The alpha 'running' seed was stopped by the locked-configuration check, so it is editable here.
      await ticket('running');
      await page.getByRole('button', { name: '修改草稿', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      const draftRow = dialog.locator('[data-fleet-draft-deliverable="0"]');
      await draftRow.waitFor();
      assert.ok((await draftRow.textContent()).includes('未绑定'));
      assert.ok((await draftRow.textContent()).includes('尚未提交产物'));
      assert.equal(await dialog.locator('[data-fleet-draft-deliverable-link="0"]').count(), 0, 'draft registry never fakes a location link');
      await dialog.locator('[data-fleet-draft-gate="quality"]').click();
      await dialog.locator('[data-fleet-gate-edit="quality"]').click();
      await dialog.locator('[data-fleet-gate-evidence]').check();
      await dialog.locator('[data-fleet-gate-rework]').check();
      await dialog.locator('[data-fleet-gate-maxrounds]').fill('3');
      await action('draft-save', () => dialog.getByRole('button', { name: '应用', exact: true }).click());
      let raw = await fixture.service.read('alpha', 'running');
      const gate = raw.plan.gates.find(g => g.id === 'quality');
      assert.equal(gate.requireEvidence, true);
      assert.equal(gate.rework.maxRounds, 3);
      await dialog.locator('.fl-popout').getByRole('button', { name: '关闭', exact: true }).click();
      await dialog.locator('.fl-popout').waitFor({ state: 'hidden' });
      await dialog.locator('[data-fleet-draft-node="build"]').click();
      await dialog.locator('[data-fleet-contract-edit="build"]').click();
      await dialog.locator('[data-fleet-contract-acceptance]').fill('Browser-added acceptance line');
      await action('draft-save', () => dialog.getByRole('button', { name: '应用', exact: true }).click());
      raw = await fixture.service.read('alpha', 'running');
      assert.ok(raw.plan.nodes.find(n => n.id === 'build').task.contract.acceptance.includes('Browser-added acceptance line'));
      await dialog.locator('.fl-popout').getByRole('button', { name: '关闭', exact: true }).click();
      await dialog.locator('.fl-popout').waitFor({ state: 'hidden' });
      await dialog.locator('[data-fleet-target-edit]').click();
      await dialog.locator('[data-fleet-target-input]').fill('deliverables');
      await action('draft-save', () => dialog.getByRole('button', { name: '应用', exact: true }).click());
      raw = await fixture.service.read('alpha', 'running');
      assert.equal(raw.plan.inputs.deliveryTarget, 'deliverables');
      await dialog.getByRole('button', { name: '关闭', exact: true }).first().click();
      await dialog.waitFor({ state: 'hidden' });
    });
    await check('new evidence and delivery copy renders in English', async () => {
      await ticket('delivered');
      await page.locator('[data-fleet-language-select]').selectOption('en');
      await page.waitForFunction(() => document.querySelector('[data-fleet-deliverable-row="0"]')?.textContent.includes('Reviewed'));
      const row = await page.locator('[data-fleet-deliverable-row="0"]').textContent();
      assert.ok(row.includes('Open location'), row);
      assert.ok((await page.locator('[data-fleet-deliverables]').textContent()).includes('Delivery target'));
      await page.locator('[data-fleet-language-select]').selectOption('zh');
      await page.waitForFunction(() => document.querySelector('[data-fleet-deliverable-row="0"]')?.textContent.includes('已审核'));
    });
    await check('deliverable detail dialog fits a 390px viewport without root overflow', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await ticket('delivered');
      await page.locator('[data-fleet-deliverable-toggle="0"]').click();
      await page.locator('[data-fleet-deliverable="0"]').click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.setViewportSize({ width: 1365, height: 1000 });
    });
    await check('dual-layer deliverables render human layer, collapsed spec and separate ticket-wide criteria', async () => {
      await ticket('clarity');
      const row0 = page.locator('[data-fleet-deliverable-row="0"]');
      await row0.waitFor();
      assert.match(await row0.locator('summary .fl-ttl strong').innerText(), /实现报告/, 'title shows on the one-line summary');
      assert.equal(await row0.evaluate(node => node.open), false, 'deliverable rows start collapsed so flow stays above the fold');
      await row0.locator('> summary').click();
      const text0 = await row0.innerText();
      assert.match(text0, /源码变更的结论与可复现验证证据/);
      assert.match(text0, /验收标准 · 1/, 'own criteria collapse behind a counted summary (P-55)');
      const crit0 = row0.locator('[data-fleet-deliverable-criteria="0"]');
      assert.equal(await crit0.evaluate(node => node.open), false, 'criteria start collapsed');
      await crit0.locator('summary').click();
      assert.match(await crit0.innerText(), /报告含可复现验证/);
      const spec = row0.locator('[data-fleet-deliverable-spec="0"]');
      assert.equal(await spec.evaluate(node => node.open), false, 'agent spec starts collapsed');
      await spec.locator('summary').click();
      assert.match(await spec.innerText(), /report\.md/);
      const row1 = page.locator('[data-fleet-deliverable-row="1"]');
      assert.match(await row1.locator('summary .fl-ttl strong').innerText(), /遗留字符串交付物/);
      assert.equal(await row1.locator('details').count(), 0, 'legacy string items keep current rendering');
      await page.locator('[data-fleet-ticket-criteria="clarity"] details summary').click();
      assert.match(await page.locator('[data-fleet-ticket-criteria="clarity"]').innerText(), /整单：保留执行证据与原生 Session 边界/);
      await screenshot('clarity-deliverables');
    });
    await check('high-level node cards show one-sentence summaries and effective model/effort, never blank', async () => {
      const build = page.locator('[data-fleet-node="build"]');
      assert.match(await build.locator('[data-fleet-node-summary="build"]').innerText(), /我会完成源码变更并记录可复现验证/);
      assert.match(await build.locator('[data-fleet-node-model="build"]').innerText(), /Fixture Fast/);
      const ship = page.locator('[data-fleet-node="ship"]');
      assert.match(await ship.locator('[data-fleet-node-summary="ship"]').innerText(), /我会核对验收证据并整理交付文件/);
      const shipModel = await ship.locator('[data-fleet-node-model="ship"]').innerText();
      assert.match(shipModel, /Fixture Default/); assert.match(shipModel, /默认/);
      await screenshot('clarity-node-cards');
    });
    await check('Agent Gate uses the node detail header and saves its model directly', async () => {
      await page.locator('[data-fleet-gate-node="agent-quality"]').click();
      const panel=page.locator('[data-fleet-gate-inspector="agent-quality"]');
      const seat=panel.locator('.fl-card-head [data-fleet-ticket-gate-model="agent-quality"]');
      await seat.waitFor();
      assert.match(await panel.innerText(), /核对报告的证据[\s\S]*报告草稿[\s\S]*核对每条引用[\s\S]*复核引用位置/);
      assert.doesNotMatch(await panel.innerText(), /编辑审核任务与依赖|查看节点|执行者与模型/);
      await seat.locator('[data-fleet-model-menu-trigger]').click();
      await seat.locator('[data-fleet-model-row="model"]').click();
      await action('draft-save',()=>seat.locator('[data-fleet-model-option="fixture-fast"]').click(),{keepsEditorOpen:false});
      const saved=await readTicket('alpha','clarity');
      assert.equal(saved.plan.gates.find(g=>g.id==='agent-quality').modelSelection.model,'fixture-fast');
      assert.equal(saved.plan.nodes.find(n=>n.id==='ship').modelSelection,undefined);
      assert.equal(await page.getByRole('dialog').count(),0);
      await page.waitForFunction(()=>{
        const seat=document.querySelector('[data-fleet-ticket-gate-model="agent-quality"]');
        return /Fixture Fast/.test(seat?.querySelector('[data-fleet-model-menu-trigger]')?.textContent||'')&&!seat?.querySelector(':popover-open');
      });
      await seat.locator('[data-fleet-model-menu-trigger]').click();
      await action('draft-save',()=>seat.locator('[data-fleet-model-row="inherit"]').click(),{keepsEditorOpen:false});
      assert.equal((await readTicket('alpha','clarity')).plan.gates.find(g=>g.id==='agent-quality').modelSelection,undefined);
    });
    await check('editing a Ticket node model and effort updates the dispatched Session', async () => {
      await page.locator('[data-fleet-node="build"]').click();
      const modal=()=>page.locator('[data-fleet-ticket-model="build"]');
      const header=page.locator('[data-fleet-thread-model="build"]');
      const before=await header.boundingBox();
      await modal().locator('[data-fleet-model-menu-trigger="seat"]').click();
      await modal().locator('[data-fleet-model-row="model"]').click();
      await action('draft-save',()=>modal().locator('[data-fleet-model-option="fixture-default"]').click(),{keepsEditorOpen:false});
      await page.waitForFunction(()=>/Fixture Default/.test(document.querySelector('[data-fleet-model-menu-trigger="seat"]')?.textContent??''));
      await modal().locator('[data-fleet-model-menu-trigger="seat"]').click();
      await modal().locator('[data-fleet-model-row="effort"]').click();
      await action('draft-save',()=>modal().locator('[data-fleet-model-option="high"]').click(),{keepsEditorOpen:false});
      await page.waitForFunction(()=>/Fixture Default · High/i.test(document.querySelector('[data-fleet-model-menu-trigger="seat"]')?.textContent??''));
      assert.ok(Math.abs((await header.boundingBox()).height-before.height)<=2,'model seat stays inside the one-line meta row');
      await page.waitForFunction(()=>!document.querySelector('.fl-seat-menu:popover-open'));
      await page.getByRole('button', { name: '确认并启动', exact: true }).click();
      await action('start', () => page.getByRole('dialog').getByRole('button', { name: '确认并启动', exact: true }).click());
      await refresh();
      const createCall = fixture.host.calls.find(c => c.method === 'create' && c.input.title?.includes('双层交付物'));
      assert.deepEqual(createCall.input.modelSelection, { provider: 'fixture', model: 'fixture-default', reasoningEffort: 'high' });
      const ticketState = await readTicket('alpha', 'clarity');
      assert.equal(ticketState.snapshot.nodes.find(n => n.id === 'build').modelSelection.reasoningEffort, 'high');
      assert.match(ticketState.snapshot.nodes.find(n => n.id === 'build').task.summary, /我会完成源码变更/);
      await page.locator('[data-fleet-node="build"]').click();
      const threadModel = page.locator('[data-fleet-thread-model="build"]');
      await threadModel.waitFor();
      const tm = await threadModel.innerText();
      assert.match(tm, /Fixture Default · high/); assert.match(tm, /节点覆盖/);
      assert.match(await page.locator('[data-fleet-thread="build"]').innerText(), /我会完成源码变更并记录可复现验证/);
    });
    await check('long agent outputs clamp to a preview line and expand verbatim', async () => {
      await ticket('delivered');
      const payload = page.locator('[data-fleet-evidence-details]').first().locator('details').first();
      await payload.waitFor();
      await payload.locator('> summary').click();
      const clamp = page.locator('[data-fleet-thread-outputs="build"]');
      await clamp.waitFor();
      assert.equal(await clamp.evaluate(node => node.open), false, 'long outputs start collapsed');
      const preview = await clamp.locator('summary').innerText();
      assert.ok(preview.startsWith('{ "artifact"'), preview);
      assert.ok(preview.endsWith('…'), preview);
      await clamp.locator('summary').click();
      const body = await clamp.locator('.fl-pre-wrap').textContent();
      const expected = (await readTicket('alpha', 'delivered')).execution.nodes.build.attempts.at(-1).outputs;
      assert.deepEqual(JSON.parse(body), expected, 'expanded body carries the verbatim JSON');
      await screenshot('thread-clamp');
    });
    await check('clarity ticket fits a 390px viewport without root overflow', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await ticket('clarity');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      await page.setViewportSize({ width: 1365, height: 1000 });
    });
    await check('clarity copy renders in English', async () => {
      await ticket('clarity');
      await page.locator('[data-fleet-language-select]').selectOption('en');
      await page.waitForFunction(() => document.querySelector('[data-fleet-deliverable-row="0"]')?.textContent.includes('Acceptance criteria'));
      await page.locator('[data-fleet-deliverable-toggle="0"]').click();
      assert.match(await page.locator('[data-fleet-deliverables="clarity"]').innerText(), /Full agent spec/);
      assert.match(await page.locator('[data-fleet-ticket-criteria="clarity"]').innerText(), /Ticket-wide acceptance criteria/);
      await page.locator('[data-fleet-language-select]').selectOption('zh');
      await page.waitForFunction(() => document.querySelector('[data-fleet-ticket-criteria="clarity"]')?.textContent.includes('整单验收标准'));
    });
    await check('Root Profile edit states shared scope and preserves started snapshots', async () => {
      const before = await sharedSnapshot(); await tab('agents'); await page.locator('[data-fleet-agent="writer"]').getByRole('button').click();
      await page.getByRole('button', { name: '编辑共享定义', exact: true }).click();
      await page.getByRole('dialog').getByText(/更新全局共享定义。已启动的任务保留原快照/).waitFor();
      await page.getByRole('textbox', { name: '角色指令', exact: true }).fill('Browser fixture revised shared role instructions.');
      await action('root-agent', () => page.getByRole('dialog').getByRole('button', { name: '确认保存', exact: true }).click());
      const catalog = await fixture.service.catalog(); assert.equal(catalog.agents.find(a => a.id === 'writer').revision, 2); assert.deepEqual(await sharedSnapshot(), before);
      assert.notEqual((await readTicket('beta', 'running')).snapshot.agents.writer.profile.instructions, catalog.agents.find(a => a.id === 'writer').profile.instructions);
    });
    await check('Root Agent model selection edits persist and stay out of started snapshots', async () => {
      const before = await sharedSnapshot(); await tab('agents'); await page.locator('[data-fleet-agent="writer"]').getByRole('button').click();
      await page.getByRole('button', { name: '编辑共享定义', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('[data-fleet-model-provider="root-"]').selectOption('fixture');
      await dialog.locator('[data-fleet-model-name="root-"]').selectOption('fixture-default');
      await dialog.locator('[data-fleet-model-effort="root-"]').selectOption('high');
      await action('root-agent', () => dialog.getByRole('button', { name: '确认保存', exact: true }).click());
      const catalog = await fixture.service.catalog();
      assert.deepEqual(catalog.agents.find(a => a.id === 'writer').profile.modelSelection, { provider: 'fixture', model: 'fixture-default', reasoningEffort: 'high' });
      assert.deepEqual(await sharedSnapshot(), before);
    });
    await check('Root Flow edit states shared scope and preserves started plans', async () => {
      const before = await sharedSnapshot(); await tab('orchestrations'); await page.getByRole('button', { name: '查看编排 ↗', exact: true }).first().click();
      await page.getByRole('button', { name: '编辑共享定义', exact: true }).click();
      await page.getByRole('dialog').getByText(/更新全局共享编排；已启动的任务保留原计划/).waitFor();
      const field = page.getByRole('textbox', { name: '编排定义 JSON', exact: true }); const definition = JSON.parse(await field.inputValue()); definition.nodes[0].task.prompt = 'Root Flow changed only for later starts.'; await field.fill(JSON.stringify(definition, null, 2));
      await action('root-flow', () => page.getByRole('dialog').getByRole('button', { name: '确认保存', exact: true }).click());
      assert.equal((await fixture.service.catalog()).orchestrations[0].revision, 2); assert.deepEqual(await sharedSnapshot(), before);
    });
    await check('view API failure stays visible and Retry recovers real data', async () => {
      fixture.failNext('view', 'Fixture view temporarily unavailable.'); await refresh();
      const alert = page.getByRole('alert').filter({ hasText: 'Fixture view temporarily unavailable.' }); await alert.waitFor();
      const response = page.waitForResponse(r => r.url().includes('/api/fleet/view') && r.status() === 200); await alert.getByRole('button', { name: '重试', exact: true }).click(); await response; await alert.waitFor({ state: 'hidden' });
      await tab('tickets'); assert((await page.locator('[data-fleet-ticket]').count()) >= 6);
    });
    await check('empty Workspace loads explicit empty state and preserves current Session', async () => {
      const before = (await snapshot()).native.sessionId; await openWorkspace('empty');
      await page.getByText('这个工作区还没有任务', { exact: true }).waitFor();
      assert.equal((await snapshot()).native.sessionId, before); assert.equal((await fixture.service.catalog()).workspaces.some(w => w.id === 'empty'), false);
    });
    await check('workspace mode toggle does not create or navigate Session', async () => {
      await page.locator('[data-fixture-control]').click();
      await page.locator('[data-fleet-control] .fl-crumb').getByText(`v${packageVersion}`,{exact:true}).waitFor();
      const rootTab = name => page.locator(`[data-fleet-root-tab="${name}"]`);
      await rootTab('attention').click();
      assert.equal(await page.locator('[data-fleet-toggle]').count(),0);
      await rootTab('settings').click();
      assert.equal(await rootTab('settings').getAttribute('aria-current'),'page');
      const before = await snapshot(); const count = fixture.host.calls.filter(c => c.method === 'create').length;
      await page.locator('[data-fleet-toggle="beta"]').click(); await page.locator('[data-fleet-open="beta"]').waitFor({ state: 'hidden' });
      const after = await snapshot(); assert.deepEqual(after.native, before.native); assert.equal(fixture.host.calls.filter(c => c.method === 'create').length, count);
      await rootTab('all').click();
      assert((await page.locator('[data-fleet-root-workspace="beta"]').count()) > 0);
      assert.equal(await page.locator('[data-fleet-toggle]').count(),0);
      await rootTab('settings').click();
      await page.locator('[data-fleet-toggle="beta"]').click(); await page.locator('[data-fleet-open="beta"]').waitFor();
      await rootTab('attention').click();
    });
    await check('Root opens the owning Ticket and reflects abandonment and restoration', async () => {
      const draft=await fixture.service.saveDraftTicket('alpha',{plan:{goal:'Root abandonment browser check'}});
      const row=page.locator(`[data-fleet-root-workspace="alpha"][data-fleet-root-ticket="${draft.id}"]`);
      await page.locator('[data-fleet-control]').getByRole('button',{name:'刷新',exact:true}).click();
      await row.click();
      await page.locator(`[data-fleet-abandon="${draft.id}"]`).click();
      await page.locator('[data-fleet-abandon-confirm]').click();
      await page.locator(`[data-fleet-unabandon="${draft.id}"]`).waitFor();
      assert((await readTicket('alpha',draft.id)).abandonedAt);
      await page.locator('[data-fixture-control]').click();
      await page.waitForFunction(id=>!document.querySelector(`[data-fleet-root-ticket="${id}"]`),draft.id);
      await page.locator('[data-fleet-show-hidden]').click();
      await row.click();
      await page.locator(`[data-fleet-unabandon="${draft.id}"]`).click();
      await page.locator(`[data-fleet-abandon="${draft.id}"]`).waitFor();
      assert.equal((await readTicket('alpha',draft.id)).abandonedAt,undefined);
    });
    for(const legacy of [false,true])await check(`cancel and confirm ${legacy?'incompatible':'compatible'} draft deletion from the list, then refresh`, async () => {
      const goal=legacy?'旧版草稿删除浏览器验收':'新版草稿删除浏览器验收';
      const draft=await fixture.service.saveDraftTicket('alpha',{plan:{goal}});
      if(legacy){
        const store=await FleetStore.open({dir:path.join(fixture.workspacePaths.alpha,'.fleet'),kind:'workspace'});
        try{await store.transaction(state=>{
          state.tickets.find(ticket=>ticket.id===draft.id).plan.contractVersion=1;
          return state;
        });}finally{await store.close();}
      }
      await openWorkspace();await tab('tickets');
      if(legacy){
        await page.getByRole('searchbox').fill('');
        await page.setViewportSize({width:1365,height:1000});
        const legacyRow=page.locator(`[data-fleet-ticket="${draft.id}"]`);
        const compatibleRow=page.locator('[data-fleet-grouped-list] [data-fleet-ticket]').filter({has:page.locator('[data-fleet-draft-menu]')}).filter({has:page.locator('[data-open-ticket]')}).first();
        for(const selector of ['.fl-upd','[data-fleet-draft-menu]']){
          const actual=await legacyRow.locator(selector).boundingBox();
          const expected=await compatibleRow.locator(selector).boundingBox();
          assert(actual&&expected&&Math.abs(actual.x-expected.x)<1,`Draft rows share the ${selector} column`);
        }
        assert.equal((await legacyRow.boundingBox()).height,(await compatibleRow.boundingBox()).height);
        const opener=legacyRow.locator('[data-fleet-draft-menu]');
        const preview=legacyRow.locator('[data-fleet-incompatible-preview]');
        const recreate=legacyRow.locator('[data-fleet-recreate-draft]');
        assert.equal(await preview.isVisible(),false);
        await opener.click();
        assert(await preview.isVisible());
        assert(await recreate.isVisible());
        assert.equal((await legacyRow.boundingBox()).height,(await compatibleRow.boundingBox()).height);
        await preview.click();
        const dialog=page.getByRole('dialog');
        await dialog.locator('[data-fleet-incompatible-goal]').waitFor();
        await page.keyboard.press('Escape');
        await dialog.waitFor({state:'hidden'});
      }
      await page.getByRole('searchbox').fill(goal);
      const row=page.locator(`[data-fleet-ticket="${draft.id}"]`);
      const remove=page.locator(`[data-fleet-draft-delete="${draft.id}"]`);
      const showConfirmation=async()=>{
        if(!await remove.isVisible())await page.locator(`[data-fleet-draft-menu="${draft.id}"]`).click();
        await remove.click();
        assert((await page.getByRole('dialog').textContent()).includes(goal));
      };
      await row.waitFor();
      assert.equal(await row.getAttribute('data-fleet-incompatible-title'),legacy?draft.id:null);
      await showConfirmation();
      await page.locator('[data-fleet-draft-delete-cancel]').click();
      assert.equal((await readTicket('alpha',draft.id)).status,'draft');
      await showConfirmation();
      const body=await action('draft-delete',()=>page.locator('[data-fleet-draft-delete-confirm]').click());
      assert.equal(body.result.deletedTicketId,draft.id);
      await row.waitFor({state:'detached'});await refresh();
      assert.equal(await row.count(),0);
      assert(!(await fixture.service.read('alpha')).some(ticket=>ticket.id===draft.id));
    });
    await check('a draft replaced by regeneration can be deleted without losing the original Ticket', async () => {
      const legacy=await fixture.service.saveDraftTicket('alpha',{plan:{goal:'已被替代的旧草稿'}});
      const replacement=await fixture.service.human('alpha','fixture-seed','regenerateTicket',[legacy.id,legacy.revision,{goal:'替代草稿浏览器验收'}]);
      await openWorkspace();await tab('tickets');
      await page.getByRole('searchbox').fill('替代草稿浏览器验收');
      const row=page.locator(`[data-fleet-ticket="${replacement.id}"]`);
      await row.waitFor();
      await page.locator(`[data-fleet-draft-menu="${replacement.id}"]`).click();
      await page.locator(`[data-fleet-draft-delete="${replacement.id}"]`).click();
      const body=await action('draft-delete',()=>page.locator('[data-fleet-draft-delete-confirm]').click());
      assert.equal(body.result.deletedTicketId,replacement.id);
      await row.waitFor({state:'detached'});
      const retained=(await fixture.service.read('alpha')).find(ticket=>ticket.id===legacy.id);
      assert.equal(retained.supersededBy,undefined);
      assert.equal(retained.replacementDeleted.ticketId,replacement.id);
    });
    // P-72／P-73: save a Ticket/node as reusable Root templates from the real Dashboard.
    await check('save running Ticket as orchestration template writes Root and appends one activity', async () => {
      await openWorkspace(); await ticket('running');
      const before = await readTicket('alpha', 'running');
      await page.locator('[data-fleet-save-orchestration="running"]').click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('[data-fleet-save-orchestration-form="running"]').waitFor();
      await dialog.locator('[data-fleet-agent-map="writer"]').waitFor();
      await dialog.locator('[data-fleet-agent-map="reviewer"]').waitFor();
      await dialog.locator('[data-fleet-template-preview]').waitFor();
      await dialog.locator('[data-fleet-agent-map-mode="writer"]').selectOption('save');
      await dialog.locator('[data-fleet-agent-map-save-id="writer"]').fill('browser-writer');
      await dialog.locator('[data-fleet-agent-map-mode="reviewer"]').selectOption('link');
      await dialog.locator('[data-fleet-agent-map-link="reviewer"]').selectOption('reviewer');
      await dialog.locator('[data-fleet-template-new-id]').fill('browser-flow');
      const body = await action('template-save-from-ticket', () => dialog.locator('[data-fleet-save-orchestration-submit]').click());
      assert.equal(body.result.template.id, 'browser-flow');
      const after = await readTicket('alpha', 'running');
      assert.equal(after.revision, before.revision, 'activity-only append keeps revision');
      assert.deepEqual(after.plan, before.plan, 'saved plan unchanged');
      assert.equal(after.events.filter(e => e.type === 'templates-saved').length, 1);
      const catalog = await fixture.service.catalog();
      const flow = catalog.orchestrations.find(o => o.id === 'browser-flow');
      assert(flow && catalog.agents.some(a => a.id === 'browser-writer'), 'save-mode Agent written');
      assert(!catalog.agents.some(a => a.id === 'browser-reviewer'), 'link-mode Agent not duplicated');
      assert.equal(flow.definition.defaults.goal, before.plan.goal);
      assert.equal(flow.definition.nodes.find(n => n.id === 'build').agentId, 'browser-writer');
      assert.equal(flow.definition.nodes.find(n => n.id === 'ship').agentId, 'reviewer');
      assert.equal(flow.definition.nodes.find(n => n.id === 'build').ticketDependencies, undefined);
      await screenshot('save-orchestration-template');
    });
    await check('save a node Agent as template copies profile without the node model by default', async () => {
      await ticket('running');
      const expectedProfile = (await readTicket('alpha', 'running')).plan.agents.writer.profile;
      await page.locator('[data-fleet-node="build"]').click();
      await page.locator('[data-fleet-thread="build"]').waitFor();
      await page.locator('[data-fleet-save-agent="build"]').click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('[data-fleet-save-agent-form="build"]').waitFor();
      assert.equal(await dialog.locator('[data-fleet-save-agent-model]').count(), 0, 'no model opt-in when the node has no modelSelection');
      await dialog.locator('[data-fleet-save-agent-id]').fill('browser-node-agent');
      const body = await action('template-save', () => dialog.locator('[data-fleet-save-agent-submit]').click());
      assert.equal(body.result.id, 'browser-node-agent');
      const catalog = await fixture.service.catalog();
      const agent = catalog.agents.find(a => a.id === 'browser-node-agent');
      assert(agent);
      assert.deepEqual(agent.profile, expectedProfile, 'profile copied as-is from the saved plan');
      assert.equal(agent.profile.modelSelection, undefined, 'decision F: node model not copied by default');
      assert.equal(agent.source.nodeId, 'build');
      assert.equal(agent.source.ticketId, 'running');
    });
    await check('Root lists expose New entry and instantiation prefills template defaults', async () => {
      await openWorkspace(); await tab('agents');
      await page.locator('[data-fleet-template-new="agent"]').waitFor();
      await tab('orchestrations');
      await page.locator('[data-fleet-template-new="orchestration"]').waitFor();
      await fixture.service.human('alpha', 'fixture-seed', 'saveTemplate', [{ kind: 'orchestration', id: 'defaults-flow', content: { nodes: [{ id: 'n', agentId: 'writer', task: { prompt: 'n' } }], gates: [], defaults: { goal: '预填目标', criteria: ['预填标准'], deliverables: ['预填交付'] } } }]);
      await refresh();
      await page.locator('[data-fleet-flow="defaults-flow"]').getByRole('button', { name: '查看编排 ↗', exact: true }).click();
      await page.locator('[data-fleet-template-instantiate="defaults-flow"]').click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('[data-fleet-instantiate-defaults]').waitFor();
      await value(dialog.locator('[data-fleet-instantiate-goal]'), '预填目标');
      await value(dialog.locator('[data-fleet-instantiate-criteria]'), '预填标准');
      await value(dialog.locator('[data-fleet-instantiate-deliverables]'), '预填交付');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
    });
    await check('all browser requests remain on independent fixture origin', async () => { assert.deepEqual(report.blockedRequests, []); assert.deepEqual(report.networkFailures.filter(r=>!(r.error==='net::ERR_ABORTED'&&r.url.startsWith(fixture.origin+'/api/fleet/progress?'))), []); assert(!report.boundary.origin.endsWith(':2399')); });
    await check('no page errors or unexpected console errors', async () => {
      assert.deepEqual(report.pageErrors, []);
      const errors = report.console.filter(row => row.type === 'error');
      const expected = fixture.requests.filter(row => row.fixtureFailure).length;
      const injectedNetworkErrors = errors.filter(row => row.text.includes('503') && ['/api/fleet/action', '/api/fleet/view'].some(p => row.location.url.startsWith(fixture.origin + p)));
      assert.equal(injectedNetworkErrors.length, expected);
      assert.deepEqual(errors.filter(row => !injectedNetworkErrors.includes(row)), []);
      return { pageErrors: 0, consoleErrors: errors.length, expectedInjected503Errors: expected, consoleWarnings: report.console.filter(row => row.type === 'warning').length };
    });
    await check('Client unload removes owned slots without replacing native root', async () => { await page.evaluate(() => window.__fleetFixture.unload()); assert.equal((await snapshot()).registeredSlots.length, 0); });
    await check('tested production sources remain unchanged throughout the browser run', async () => {
      for (const [file, hash] of Object.entries(sourceHashes)) assert.equal(createHash('sha256').update(await fs.readFile(path.join(repository, file))).digest('hex'), hash, `Source changed during validation: ${file}`);
    });
  } catch (error) {
    report.checks.push({ name: 'fixture setup or prerequisite', status: 'failed', error: error.stack ?? String(error) });
    if (page) { try { await screenshot('failure'); } catch {} }
  } finally {
    if (context) await context.close();
    report.apiRequests = fixture.requests;
    report.adapterCalls = Object.fromEntries(['create', 'submit', 'inspect', 'cancel', 'message'].map(method => [method, fixture.host.calls.filter(row => row.method === method).length]));
    report.finishedAt = new Date().toISOString();
    report.summary = { total: report.checks.length, passed: report.checks.filter(row => row.status === 'passed').length, failed: report.checks.filter(row => row.status === 'failed').length, screenshots: report.screenshots.length, pageErrors: report.pageErrors.length, consoleErrors: report.console.filter(row => row.type === 'error').length, expectedInjectedFailures: fixture.requests.filter(row => row.fixtureFailure).length };
    report.status = report.summary.failed ? 'FAIL' : 'PASS';
    try { await fixture.close(); await removeOwnedTemp(profile, 'fleet-ui-edge-'); report.temporaryResourcesRemoved = true; }
    catch (error) { report.cleanupError = String(error.stack ?? error); report.status = 'FAIL'; }
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, ...report.summary, output }));
    if (report.status !== 'PASS') process.exitCode = 1;
  }
}
