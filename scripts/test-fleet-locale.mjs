import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFleetLanguage, fleetLanguageStorageKey, fleetDictionaries, fleetTranslator, fleetResponseError, fleetErrorRecord, fleetErrorText } from '../packages/fleet-shell/src/fleet-locale.js';

function memoryStorage(initial = null) {
  const values = new Map(initial === null ? [] : [[fleetLanguageStorageKey, initial]]), writes = [];
  return {
    writes, getItem: key => values.get(key) ?? null,
    setItem(key, value) { writes.push(['set', key, value]); values.set(key, String(value)); },
    removeItem(key) { writes.push(['remove', key]); values.delete(key); }
  };
}
function host(active = 'zh') {
  let snapshot = { active };
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    change(active) { snapshot = { active }; for (const listener of listeners) listener(); },
    listenerCount: () => listeners.size
  };
}
function events() {
  const listeners = new Set();
  return {
    addEventListener(type, listener) { assert.equal(type, 'storage'); listeners.add(listener); },
    removeEventListener(type, listener) { assert.equal(type, 'storage'); listeners.delete(listener); },
    dispatch(event) { for (const listener of listeners) listener(event); },
    listenerCount: () => listeners.size
  };
}
function fixture(t, { active = 'zh', initial = null, storage = memoryStorage(initial) } = {}) {
  const locale = host(active), eventTarget = events();
  const store = createFleetLanguage(locale, { storage: () => storage, events: eventTarget });
  t.after(() => store.dispose());
  return { locale, storage, events: eventTarget, store };
}
const state = (store, preference, language) => assert.deepEqual(store.getSnapshot(), { languagePreference: preference, language });

test('default auto follows HostLocale active and normalizes Chinese regions and other languages', t => {
  const { store, locale, storage } = fixture(t);
  state(store, 'auto', 'zh');
  for (const [active, language] of [['en', 'en'], ['zh-CN', 'zh'], ['zh-TW', 'zh'], ['zh_HK', 'zh'], ['ZH-cn', 'zh'], ['ja-JP', 'en'], ['fr', 'en'], ['zhong', 'en']]) {
    locale.change(active); state(store, 'auto', language);
  }
  assert.deepEqual(storage.writes, []);
});

test('manual preference updates Fleet only and ignores later Host changes', t => {
  const { store, locale, storage } = fixture(t);
  const originalHost = locale.getSnapshot();
  store.setPreference('en'); state(store, 'en', 'en');
  assert.strictEqual(locale.getSnapshot(), originalHost);
  assert.deepEqual(storage.writes, [['set', fleetLanguageStorageKey, 'en']]);
  locale.change('zh-TW'); state(store, 'en', 'en');
  store.setPreference('zh'); locale.change('en'); state(store, 'zh', 'zh');
  assert.equal(locale.getSnapshot().active, 'en');
});

test('persisted choice survives disposal and store reconstruction', t => {
  const { store, locale, storage, events: eventTarget } = fixture(t);
  store.setPreference('en'); store.dispose();
  const rebuilt = createFleetLanguage(locale, { storage: () => storage, events: eventTarget });
  t.after(() => rebuilt.dispose());
  state(rebuilt, 'en', 'en');
  assert.equal(locale.listenerCount(), 1);
  assert.equal(eventTarget.listenerCount(), 1);
});

test('auto removes persisted preference and resumes Host following immediately', t => {
  const { store, locale, storage } = fixture(t, { initial: 'en' });
  state(store, 'en', 'en'); store.setPreference('auto'); state(store, 'auto', 'zh');
  assert.equal(storage.getItem(fleetLanguageStorageKey), null);
  assert.deepEqual(storage.writes, [['remove', fleetLanguageStorageKey]]);
  locale.change('en'); state(store, 'auto', 'en');
});

test('invalid stored values resolve to auto without modifying browser storage', t => {
  for (const initial of ['', 'auto', 'fr', 'ZH', 'zh-CN', 'null', '{"language":"en"}', '__proto__']) {
    const { store, storage } = fixture(t, { initial });
    state(store, 'auto', 'zh'); assert.deepEqual(storage.writes, []);
  }
});

test('unavailable storage access and throwing methods preserve in-memory choices', t => {
  const throwing = () => { throw new Error('Storage disabled'); };
  for (const storage of [undefined, { getItem: throwing, setItem: throwing, removeItem: throwing }]) {
    const locale = host('zh');
    const store = createFleetLanguage(locale, { storage: storage === undefined ? throwing : () => storage, events: events() });
    t.after(() => store.dispose());
    state(store, 'auto', 'zh');
    assert.doesNotThrow(() => store.setPreference('en')); state(store, 'en', 'en');
    assert.doesNotThrow(() => store.setPreference('auto')); state(store, 'auto', 'zh');
    locale.change('en'); state(store, 'auto', 'en');
  }
});

test('storage events synchronize preferences across pages and do not echo writes', t => {
  const { store, locale, storage, events: eventTarget } = fixture(t);
  const incoming = newValue => eventTarget.dispatch({ key: fleetLanguageStorageKey, newValue, storageArea: storage });
  incoming('en'); state(store, 'en', 'en');
  incoming('zh'); locale.change('en'); state(store, 'zh', 'zh');
  incoming(null); state(store, 'auto', 'en');
  incoming('invalid'); state(store, 'auto', 'en');
  incoming('zh'); eventTarget.dispatch({ key: null, newValue: null, storageArea: storage }); state(store, 'auto', 'en');
  assert.deepEqual(storage.writes, []);
});

test('unrelated storage keys and other storage areas are ignored', t => {
  const { store, storage, events: eventTarget } = fixture(t);
  const before = store.getSnapshot();
  eventTarget.dispatch({ key: 'some-other-preference', newValue: 'en', storageArea: storage });
  eventTarget.dispatch({ key: fleetLanguageStorageKey, newValue: 'en', storageArea: memoryStorage() });
  assert.strictEqual(store.getSnapshot(), before);
  eventTarget.dispatch({ key: fleetLanguageStorageKey, newValue: 'en', storageArea: null });
  state(store, 'en', 'en');
});

test('snapshot identity and notifications change only when effective state changes', t => {
  const { store, locale } = fixture(t);
  let notified = 0;
  const unsubscribe = store.subscribe(() => notified++), before = store.getSnapshot();
  assert(Object.isFrozen(before));
  locale.change('zh-CN'); assert.strictEqual(store.getSnapshot(), before); assert.equal(notified, 0);
  store.setPreference('zh'); state(store, 'zh', 'zh'); assert.equal(notified, 1);
  const manual = store.getSnapshot(); store.setPreference('zh'); locale.change('en');
  assert.strictEqual(store.getSnapshot(), manual); assert.equal(notified, 1);
  for (const invalid of ['', 'auto ', 'zh-CN', null, undefined]) store.setPreference(invalid);
  assert.strictEqual(store.getSnapshot(), manual); assert.equal(notified, 1);
  unsubscribe(); store.setPreference('en'); assert.equal(notified, 1);
});

test('dispose removes Host and storage subscriptions and stops subsequent updates', t => {
  const { store, locale, storage, events: eventTarget } = fixture(t);
  let notified = 0; store.subscribe(() => notified++);
  assert.equal(locale.listenerCount(), 1); assert.equal(eventTarget.listenerCount(), 1);
  const before = store.getSnapshot();
  store.dispose(); store.dispose();
  assert.equal(locale.listenerCount(), 0); assert.equal(eventTarget.listenerCount(), 0);
  locale.change('en'); eventTarget.dispatch({ key: fleetLanguageStorageKey, newValue: 'en', storageArea: storage }); store.setPreference('en');
  assert.strictEqual(store.getSnapshot(), before); assert.equal(notified, 0); assert.deepEqual(storage.writes, []);
});

test('missing Host and browser services use English fallback and remain disposable', () => {
  const store = createFleetLanguage(undefined, { storage: () => undefined, events: undefined });
  state(store, 'auto', 'en'); store.setPreference('zh'); state(store, 'zh', 'zh'); store.dispose();
});

test('Chinese and English dictionaries have matching complete keys and placeholders', async () => {
  assert.deepEqual(Object.keys(fleetDictionaries.zh).sort(), Object.keys(fleetDictionaries.en).sort());
  const source = (await Promise.all(['fleet-client.js', 'fleet-ui.js'].map(file => readFile(new URL('../packages/fleet-shell/src/' + file, import.meta.url), 'utf8')))).join('\n');
  const used = [...source.matchAll(/\bt\('([^']+)'\)/g)].map(match => match[1]);
  used.push('control', 'actionSaved', 'saved', 'saving', 'enable', 'disable', 'modeOn', 'available', 'disabledTarget', 'unavailable', 'requestFailed', 'invalidResponseVersion', 'invalidModesResponse', 'invalidWorkspaceResponse', 'invalidActionResponse');
  const placeholders = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const key of new Set(used)) for (const language of ['zh', 'en']) assert.equal(typeof fleetDictionaries[language][key], 'string', `${language}.${key}`);
  for (const key of Object.keys(fleetDictionaries.en)) {
    assert(fleetDictionaries.en[key].trim(), `Empty English value: ${key}`);
    assert(fleetDictionaries.zh[key].trim(), `Empty Chinese value: ${key}`);
    assert.deepEqual(placeholders(fleetDictionaries.zh[key]), placeholders(fleetDictionaries.en[key]), key);
    if (!['control', 'panel'].includes(key)) assert.notEqual(fleetDictionaries.zh[key], fleetDictionaries.en[key], `Untranslated key: ${key}`);
  }
});

test('translation substitutes once and preserves user text, braces and replacement syntax verbatim', () => {
  const raw = '用户原文 中文 / Ticket Goal {name} {detail} $& $` <b>unchanged</b> 🧪';
  const parameters = Object.freeze({ name: raw, detail: raw });
  for (const language of ['zh', 'en']) {
    const t = fleetTranslator(language);
    assert.equal(t('open', parameters), fleetDictionaries[language].open.replace('{name}', () => raw));
    assert.equal(t('requestFailed', parameters), fleetDictionaries[language].requestFailed.replace('{detail}', () => raw));
    assert.equal(t('open'), fleetDictionaries[language].open);
    assert.equal(t('unregistered-user-value'), 'unregistered-user-value');
    assert.equal(t('open', { name: 0 }), fleetDictionaries[language].open.replace('{name}', '0'));
  }
});

test('localized errors preserve provider detail and relocalize Fleet-owned errors', () => {
  const detail = '用户错误原文 {detail} $& Native backend message';
  const record = fleetErrorRecord(new Error(detail));
  assert.deepEqual(record, { key: 'requestFailed', detail });
  for (const language of ['zh', 'en']) {
    const t = fleetTranslator(language);
    assert.equal(fleetErrorText(record, t), fleetDictionaries[language].requestFailed.replace('{detail}', () => detail));
    assert.equal(fleetErrorText(fleetErrorRecord(fleetResponseError('invalidWorkspaceResponse')), t), t('invalidWorkspaceResponse'));
    assert.equal(fleetErrorText(detail, t), detail); assert.equal(fleetErrorText(null, t), null);
  }
});
