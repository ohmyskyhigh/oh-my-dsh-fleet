// Usage: node scripts/review-fleet-orchestration.mjs (FLEET_TEST_BROWSER can point to an installed Chromium browser).
// The fixture serves the generated Client and production Dashboard API on an ephemeral loopback port.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createFleetUIFixture } from './fixtures/fleet-ui-server.mjs';

const output = new URL('../.artifacts/fleet-orchestration-ui/', import.meta.url);
const generatedClient = new URL('../client.js', import.meta.url);
const ids = { consumer: 'orchestration-review', whole: 'whole-upstream', step: 'step-upstream', follower: 'recurring-follower' };
const node = (id, dependsOn = []) => ({ id, agentId: 'worker', dependsOn, task: { prompt: `Run ${id}.` } });
const plan = (goal, nodes, deliverables = []) => ({
  contractVersion: 3, goal, nodes, deliverables, agents: { worker: { profile: { agentPreset: 'fixture-preset' } } }, gates: []
});
const routeDefinitions = [
  { id: 'index-fix', to: ['fix-index'], condition: { path: ['signals', 'index'], operator: 'lt', value: 0 } },
  { id: 'traffic-fix', to: ['fix-traffic'], condition: { path: ['signals', 'traffic'], operator: 'lt', value: 0 } },
  { id: 'manual-fix', to: ['fix-manual'], condition: { path: ['signals', 'manual'], operator: 'eq', value: true } }
];
const report = {
  boundary: 'Generated Fleet Client with real React, Dashboard API and FleetService; isolated loopback, temporary workspaces and fixture Sessions',
  clientSha256: createHash('sha256').update(await fs.readFile(generatedClient)).digest('hex'),
  checks: [], pageErrors: [], blockedRequests: [], status: 'failed'
};
await fs.mkdir(output, { recursive: true });
let fixture, browser, page;

async function check(name, run) {
  try {
    const evidence = await run();
    report.checks.push({ name, status: 'passed', evidence });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, status: 'failed', error: error.stack });
    throw error;
  }
}

try {
  const schedules = new Map();
  fixture = await createFleetUIFixture({ scheduleAdapter: {
    async scheduleCreate({ title, timing }) {
      const id = `fixture-schedule-${schedules.size + 1}`;
      const schedule = { id, title, status: 'active', timing, target: { sessionId: `fixture-origin-${id}` } };
      schedules.set(id, schedule);
      return structuredClone(schedule);
    },
    async scheduleView({ id }) { return structuredClone(schedules.get(id)); },
    async scheduleHistory() { return { records: [] }; }
  } });
  const service = fixture.service;
  const save = (id, input) => service.saveDraftTicket('alpha', { id, sessionId: 'seed', plan: input });
  const read = id => service.read('alpha', id);
  const readConsumer = () => read(ids.consumer);
  await save(ids.whole, plan('Collect whole-Ticket input', [node('collect')], ['Index capture']));
  await save(ids.step, plan('Collect Step input', [node('collect')], ['Traffic capture']));
  await save(ids.consumer, plan('Run independent preparation and route work based on collected signals', [
    node('prepare'), node('analyze'), node('fix-index'), node('fix-traffic'), node('fix-manual'),
    node('join', ['fix-index', 'fix-traffic', 'fix-manual'])
  ], [{ title: 'Traffic branch report', text: 'Produce the traffic branch report.' }]));
  for (const id of [ids.whole, ids.step]) await service.human('alpha', 'fixture', 'start', [id]);
  await service.tick();

  const session = async (ticketId, nodeId) => {
    const step = (await read(ticketId)).execution.nodes[nodeId];
    assert.equal(step.status, 'running', `${ticketId}/${nodeId}`);
    assert.ok(step.attempts.at(-1)?.sessionId, `${ticketId}/${nodeId} has an execution Session`);
    return step.attempts.at(-1).sessionId;
  };
  // Simulate agent evidence and native Session completion through the existing fixture adapter.
  async function deliverUpstream(id) {
    const sessionId = await session(id, 'collect');
    const file = `${id}.txt`;
    await fs.writeFile(path.join(fixture.workspacePaths.alpha, file), `${id} collected\n`);
    await service.submitEvidence({ sessionId, payload: { summary: `${id} collected`, artifacts: [{ path: file, deliverableIndex: 0 }] } });
    fixture.host.sessions.set(sessionId, { status: 'completed', output: `${id} completed` });
    await service.tick();
    assert.equal((await read(id)).status, 'delivered');
  }

  const executablePath = process.env.FLEET_TEST_BROWSER;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}),
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = route.request().url();
    if (new URL(url).origin === fixture.origin) return route.continue();
    report.blockedRequests.push(url);
    return route.abort('blockedbyclient');
  });
  page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => report.pageErrors.push(error.stack ?? error.message));
  const $ = selector => page.locator(selector);
  const button = name => page.getByRole('button', { name, exact: true });
  const card = id => $(`[data-fleet-ticket-card="${id}"]`);
  const ticket = async id => {
    await $('[data-fleet-tab="tickets"]').click();
    await $(`[data-open-ticket="${id}"]`).click();
    await card(id).waitFor();
  };
  const action = async (name, click, ticketId = ids.consumer) => {
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url() === `${fixture.origin}/api/fleet/action` && r.request().postDataJSON()?.action === name),
      click()
    ]);
    assert.equal(response.status(), 200, await response.text());
    const request = response.request().postDataJSON();
    assert.equal(request.workspaceId, 'alpha');
    assert.equal(request.ticketId ?? request.sourceTicketId, ticketId);
    return request;
  };
  const refresh = async () => {
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().startsWith(`${fixture.origin}/api/fleet/view?`) && r.request().method() === 'GET'),
      button('Refresh').click()
    ]);
    assert.ok(response.ok(), await response.text());
  };
  const draftDialog = () => $('dialog[open] [data-fleet-draft-editor]');
  const editor = () => draftDialog().locator('[data-fleet-routing-editor]');
  const openEditor = async () => {
    await button('Edit draft').click();
    await editor().locator('> summary').click();
  };
  const closeEditor = async () => {
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  };
  const stepScope = () => editor().locator('details').filter({ has: page.getByText(/^Step · analyze \(/) });
  const upstreamPicker = scope => scope.getByLabel(/^Upstream Tickets/);
  const gate = () => $('[data-fleet-logic-gate="signals"]');
  const route = id => gate().locator(`[data-fleet-route="${id}"]`);
  const routeStatus = (id, text) => route(id).locator('> summary').getByText(text, { exact: true }).waitFor();

  await page.goto(fixture.origin);
  await page.waitForFunction(() => window.__fleetFixture?.ready);
  await page.evaluate(() => window.__fleetFixture.language('en'));
  await $('[data-fixture-control]').click();
  await $('[data-fleet-root-tab="settings"]').click();
  await $('[data-fleet-open="alpha"]').click();
  await $('[data-fleet-panel-workspace-id="alpha"]').waitFor();
  await ticket(ids.consumer);

  await check('Dashboard saves whole-Ticket and Step selections with typed route definitions', async () => {
    await openEditor();
    const entire = upstreamPicker(editor()).first();
    assert.equal(await entire.locator(`option[value="${ids.consumer}"]`).count(), 0);
    await entire.selectOption('delivered');
    await entire.selectOption(ids.whole);
    await stepScope().locator('summary').click();
    await upstreamPicker(stepScope()).selectOption(ids.step);
    await editor().getByRole('button', { name: 'Add logic gate', exact: true }).click();
    await editor().getByLabel('Gate ID', { exact: true }).fill('signals');
    await editor().getByLabel(/^Handoff source step/).selectOption('analyze');
    for (const [index, definition] of routeDefinitions.entries()) {
      if (index) await editor().getByRole('button', { name: 'Add route', exact: true }).click();
      const routeForm = editor().getByRole('group', { name: 'New route', exact: true });
      await routeForm.getByLabel('Route ID', { exact: true }).fill(definition.id);
      const row = editor().getByRole('group', { name: definition.id, exact: true });
      await row.getByLabel(/^Steps to run on match/).selectOption(definition.to[0]);
      await row.getByLabel('Handoff path (one key per line)', { exact: true }).fill(definition.condition.path.join('\n'));
      await row.getByLabel(/^Condition/).selectOption(definition.condition.operator);
      await row.getByLabel(/^Comparison value/).fill(JSON.stringify(definition.condition.value));
    }
    await editor().getByLabel(/^Traffic branch report/).selectOption('fix-traffic');
    const request = await action('draft-save', () => draftDialog().locator('[data-fleet-draft-save]').click());
    await draftDialog().locator('[data-fleet-draft-state="saved"]').waitFor();
    const saved = await readConsumer();
    assert.deepEqual(request.plan, saved.plan);
    assert.deepEqual(saved.plan.ticketDependencies, ['delivered', ids.whole]);
    assert.deepEqual(saved.plan.nodes.find(n => n.id === 'analyze').ticketDependencies, [ids.step]);
    assert.deepEqual(saved.plan.logicGates, [{ id: 'signals', from: 'analyze', routes: routeDefinitions }]);
    assert.equal(saved.plan.deliverables[0].whenNodeRuns, 'fix-traffic');
    assert.equal(saved.status, 'draft');
    assert.ok(!saved.dependencyAuthorization);
    await closeEditor();
    await openEditor();
    await editor().getByRole('button', { name: `Remove ${ids.whole}`, exact: true }).waitFor();
    await stepScope().locator('summary').click();
    await stepScope().getByRole('button', { name: `Remove ${ids.step}`, exact: true }).waitFor();
    assert.equal(await editor().getByRole('group', { name: 'index-fix', exact: true }).getByLabel(/^Comparison value/).inputValue(), '0');
    await closeEditor();
    return { revision: saved.revision, ticketDependencies: saved.plan.ticketDependencies, stepDependencies: [ids.step], routes: routeDefinitions };
  });

  await check('Enabling and withdrawing the wait are explicit Dashboard actions', async () => {
    const wholeLink = $(`[data-fleet-open-upstream="${ids.whole}"]`);
    await wholeLink.waitFor();
    await $(`[data-fleet-upstream="${ids.consumer}"]`).getByText('Index capture', { exact: true }).waitFor();
    await wholeLink.click();
    await card(ids.whole).waitFor();
    await ticket(ids.consumer);
    const dependencyButton = name => $(`[data-fleet-dependency-action="${name}"]`);
    const enable = () => action('dependency-enable', () => dependencyButton('dependency-enable').click());
    await enable();
    let waiting = await readConsumer();
    assert.equal(waiting.status, 'draft');
    assert.ok(waiting.dependencyAuthorization);
    assert.equal(waiting.execution, null);
    await action('dependency-disable', () => dependencyButton('dependency-disable').click());
    assert.ok(!(await readConsumer()).dependencyAuthorization);
    await enable();
    waiting = await readConsumer();
    assert.equal(waiting.execution, null);
    assert.ok(waiting.dependencyAuthorization);
    return { revision: waiting.revision, authorized: true, status: waiting.status };
  });

  await check('After upstream delivery the Ticket runs while its dependent Step remains waiting', async () => {
    await deliverUpstream(ids.whole);
    await service.tick(); // Dispatch the Ticket authorized and started at the end of the previous tick.
    await refresh();
    await $('[data-fleet-node="analyze"]').click();
    const waiting = $(`[data-fleet-upstream="analyze"]`);
    await waiting.getByText('Awaiting upstream delivery', { exact: true }).waitFor();
    await waiting.getByText('Traffic capture', { exact: true }).waitFor();
    await waiting.locator(`[data-fleet-open-upstream="${ids.step}"]`).click();
    await card(ids.step).waitFor();
    await ticket(ids.consumer);
    const started = await readConsumer();
    assert.equal(started.status, 'running');
    assert.equal(started.execution.nodes.prepare.status, 'running');
    assert.equal(started.execution.nodes.prepare.attempts.length, 1);
    assert.equal(started.execution.nodes.analyze.status, 'pending');
    assert.equal(started.execution.nodes.analyze.attempts.length, 0);
    await routeStatus('index-fix', 'Pending');
    await deliverUpstream(ids.step);
    await refresh();
    await $('[data-fleet-node="analyze"]').click();
    await session(ids.consumer, 'analyze');
    const attempt = (await readConsumer()).execution.nodes.analyze.attempts.at(-1);
    const frozen = $(`[data-fleet-upstream-attempt="${attempt.id}"]`);
    await frozen.getByText('Traffic capture', { exact: true }).waitFor();
    const delivery = attempt.upstreamTickets.find(source => source.ticketId === ids.step).deliverables[0];
    await frozen.getByText(delivery.sha256, { exact: true }).waitFor();
    const file = await frozen.getByRole('link', { name: delivery.snapshotPath, exact: true }).getAttribute('href');
    const fileURL = new URL(file, fixture.origin);
    assert.equal(fileURL.origin, fixture.origin);
    const bytes = await page.request.get(fileURL.href);
    assert.equal(bytes.status(), 200);
    assert.equal(createHash('sha256').update(await bytes.body()).digest('hex'), delivery.sha256);
    return { status: started.status, independentStep: started.execution.nodes.prepare.status, dependentStepBeforeDelivery: 'pending', dependentStepAfterDelivery: 'running' };
  });

  await check('Route results show executed, unmatched and failed outcomes with linked Steps', async () => {
    const analyze = await session(ids.consumer, 'analyze');
    await service.submitEvidence({ sessionId: analyze, payload: { summary: 'Three routing results', handoff: { signals: { index: -1, traffic: 2, manual: true } } } });
    fixture.host.sessions.set(analyze, { status: 'completed', output: 'Analysis completed' });
    await service.tick();
    await refresh();
    await routeStatus('index-fix', 'Running');
    await routeStatus('traffic-fix', 'Unmatched · skipped');
    await routeStatus('manual-fix', 'Running');
    const index = await session(ids.consumer, 'fix-index');
    const manual = await session(ids.consumer, 'fix-manual');
    fixture.host.sessions.set(index, { status: 'completed', output: 'Index fixed' });
    fixture.host.sessions.set(manual, { status: 'failed', error: 'Fixture manual fix failed' });
    await service.tick();
    await refresh();
    await routeStatus('index-fix', 'Executed');
    await routeStatus('traffic-fix', 'Unmatched · skipped');
    await routeStatus('manual-fix', 'Failed');
    const failedRoute = route('manual-fix');
    const target = failedRoute.getByRole('button', { name: 'fix-manual', exact: true });
    assert.equal(await failedRoute.evaluate(element => element.open), false);
    assert.equal(await target.isVisible(), false);
    await failedRoute.locator('> summary').click();
    const sourceAttempt = (await readConsumer()).execution.nodes.analyze.attempts.at(-1).id;
    await failedRoute.getByText(sourceAttempt, { exact: true }).waitFor();
    await failedRoute.getByText('"signals" → "manual" eq true', { exact: true }).waitFor();
    await target.click();
    await $('[data-fleet-thread="fix-manual"]').waitFor();
    const result = await readConsumer();
    assert.equal(result.execution.nodes['fix-traffic'].status, 'skipped');
    assert.equal(result.execution.nodes['fix-traffic'].attempts.length, 0);
    assert.equal(result.execution.nodes.join.status, 'pending');
    assert.equal(result.execution.nodes.join.attempts.length, 0);
    await $('[data-fleet-deliverable-row="0"]').getByText('Skipped', { exact: true }).waitFor();
    await gate().screenshot({ path: fileURLToPath(new URL('routes.png', output)) });
    return { routes: { 'index-fix': 'completed', 'traffic-fix': 'skipped', 'manual-fix': 'failed' }, join: 'pending' };
  });
  await check('Dashboard follows a selected upstream series without creating a second timer', async () => {
    await save(ids.follower, plan('Analyze each collection', [node('analyze')]));
    const upstreamSeries = [];
    for (const sourceTicketId of [ids.whole, ids.step]) {
      upstreamSeries.push(await service.seriesCreate('alpha', {
        sourceTicketId, name: `${sourceTicketId} daily`, timing: { kind: 'daily', daily: { time: '09:00', time_zone: 'UTC' } }
      }));
    }
    assert.equal(schedules.size, 2);
    await refresh();
    await ticket(ids.follower);
    await openEditor();
    const seriesPicker = scope => scope.getByLabel(/^Match upstream series per occurrence/);
    await seriesPicker(editor()).first().selectOption(upstreamSeries[0].id);
    await stepScope().locator('summary').click();
    await seriesPicker(stepScope()).selectOption(upstreamSeries[1].id);
    await action('draft-save', () => draftDialog().locator('[data-fleet-draft-save]').click(), ids.follower);
    await draftDialog().locator('[data-fleet-draft-state="saved"]').waitFor();
    await closeEditor();
    const saved = await read(ids.follower);
    assert.deepEqual(saved.plan.ticketDependencySeries, [upstreamSeries[0].id]);
    assert.deepEqual(saved.plan.nodes[0].ticketDependencySeries, [upstreamSeries[1].id]);
    const follow = $(`[data-fleet-series-follow="${ids.follower}"]`);
    await follow.waitFor();
    assert.ok(await follow.isDisabled());
    const trigger = upstreamSeries[1];
    await $('[data-fleet-follow-trigger]').selectOption(trigger.id);
    const request = await action('series-follow', () => follow.click(), ids.follower);
    assert.equal(request.triggerSeriesId, trigger.id);
    assert.equal(request.expectedRevision, saved.revision);
    await button('Following upstream series').waitFor();
    assert.ok(await follow.isDisabled());
    const matches = (await service.readSeries('alpha')).filter(series => series.sourceTicketId === ids.follower);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].triggerSeriesId, trigger.id);
    assert.equal(matches[0].scheduleId, trigger.scheduleId);
    assert.equal(schedules.size, 2);
    return { followerId: matches[0].id, triggerId: trigger.id, scheduleId: trigger.scheduleId, hostTimersBefore: 2, hostTimersAfter: schedules.size };
  });
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.blockedRequests, []);
  report.status = 'passed';
} catch (error) {
  report.error = error.stack ?? String(error);
  console.error(report.error);
  if (page) {
    const visible = page.getByRole('dialog').or(page.locator('[data-fleet-panel-workspace-id]')).last();
    report.visibleState = await visible.ariaSnapshot({ timeout: 2000 }).catch(() => null);
  }
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } finally {
    try { await fixture?.close(); } finally {
      await fs.writeFile(new URL('report.json', output), JSON.stringify(report, null, 2) + '\n');
    }
  }
}
