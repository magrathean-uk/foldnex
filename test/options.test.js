import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import * as ai from '../src/ai-engine.js';
import { isOnDeviceEngine } from '../src/background-classifier.js';

const OPTIONS_HTML = await readFile(new URL('../options/options.html', import.meta.url), 'utf8');
const OPTIONS_SCRIPT = (await readFile(new URL('../options/options.js', import.meta.url), 'utf8'))
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*/gm, '');
const PROVIDER_USAGE_KEY = 'foldnex_provider_usage_v1';
const flush = () => new Promise(resolve => setImmediate(resolve));

class FakeElement {
  constructor(tag, attributes = {}) {
    this.tagName = tag.toUpperCase();
    this.attributes = new Map(Object.entries(attributes));
    this.id = attributes.id || '';
    this.name = attributes.name || '';
    this.value = attributes.value || '';
    this.checked = 'checked' in attributes;
    this.disabled = false;
    this.children = [];
    this.listeners = {};
    this.dataset = Object.fromEntries(Object.entries(attributes).filter(([name]) => name.startsWith('data-'))
      .map(([name, value]) => [name.slice(5), value]));
    this.style = {};
    this._text = '';
    this.className = attributes.class || '';
  }
  set className(value) {
    const names = new Set(String(value).split(/\s+/).filter(Boolean));
    this.classList = {
      contains: name => names.has(name),
      add: (...values) => values.forEach(name => names.add(name)),
      remove: (...values) => values.forEach(name => names.delete(name)),
      toggle(name, force) {
        const on = force === undefined ? !names.has(name) : Boolean(force);
        if (on) names.add(name); else names.delete(name);
        return on;
      }
    };
  }
  get textContent() { return this._text; }
  set textContent(value) { this._text = String(value); this.children = []; }
  set innerHTML(value) { assert.equal(value, ''); this.children = []; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  toggleAttribute(name, force) { if (force) this.setAttribute(name, ''); else this.attributes.delete(name); }
  append(...nodes) { this.children.push(...nodes); }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  async fire(type) {
    await Promise.all((this.listeners[type] || []).map(listener => listener({ target: this, preventDefault() {} })));
    await flush();
  }
  focus() {}
  scrollIntoView() {}
  descendants() { return this.children.flatMap(child => child instanceof FakeElement ? [child, ...child.descendants()] : []); }
  matches(selector) {
    const tag = selector.match(/^[a-z]+/)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (![...selector.matchAll(/\.([\w-]+)/g)].every(([, name]) => this.classList.contains(name))) return false;
    return [...selector.matchAll(/\[([\w-]+)="([^"]*)"\]/g)]
      .every(([, name, value]) => String(this[name] ?? this.getAttribute(name)) === value);
  }
  querySelectorAll(selector) { return this.descendants().filter(element => element.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function parseOptions() {
  const html = OPTIONS_HTML.slice(OPTIONS_HTML.indexOf('<body'), OPTIONS_HTML.indexOf('</body>'));
  const root = new FakeElement('body');
  const stack = [root];
  for (const [, closing, tag, rawAttributes, text] of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g)) {
    const parent = stack.at(-1);
    if (text !== undefined) { if (text.trim()) parent._text += text.trim(); continue; }
    if (closing) { stack.pop(); continue; }
    const attributes = Object.fromEntries([...rawAttributes.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)]
      .map(([, name, value]) => [name, value ?? '']));
    const element = new FakeElement(tag, attributes);
    parent.append(element);
    if (!['meta', 'link', 'img', 'input', 'br'].includes(tag.toLowerCase())) stack.push(element);
  }
  return root;
}

async function openOptions({
  sync = { provider: 'openai' }, run = null, usage = {}, nano = 'ready',
  catalogError = null, connectionError = null, models = ['gpt-6'], storedLocal = {},
  catalogResponse = null, connectionResponse = null, savedSettingsResponse = null, saveSecretsResponse = null
} = {}) {
  const root = parseOptions();
  const local = { ...storedLocal, ...(run ? { foldnex_last_run: run } : {}) };
  const storageListeners = [];
  const documentListeners = {};
  const requests = [];
  const catalogRequests = [];
  let settingsReads = 0;
  const warnings = [];
  let summary = usage;
  const emitStorage = async (key, value, areaName) => {
    storageListeners.forEach(listener => listener({ [key]: { newValue: value } }, areaName));
    await flush();
  };
  const makeArea = (store, areaName) => ({
    async get(keys) {
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in store).map(key => [key, store[key]]));
    },
    async set(values) { Object.assign(store, values); for (const [key, value] of Object.entries(values)) await emitStorage(key, value, areaName); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]; }
  });
  const context = vm.createContext({
    ...ai,
    checkChromeNanoStatus: async () => ({ status: nano, detail: 'Synthetic model availability' }),
    isOnDeviceEngine,
    PROVIDER_USAGE_KEY,
    readProviderUsageSummary: async () => summary,
    clearProviderUsage: async () => { summary = {}; },
    loadSavedSettings: async () => savedSettingsResponse
      ? savedSettingsResponse(++settingsReads, { ...sync, ...local })
      : { ...sync, ...local },
    saveProviderSecrets: async values => {
      if (saveSecretsResponse) await saveSecretsResponse(values);
      Object.assign(local, values);
    },
    labelTabsWithAI: async (tabs, settings) => {
      requests.push({ tabs, settings });
      if (connectionResponse) return connectionResponse({ tabs, settings }, requests.length);
      if (connectionError) throw new Error(connectionError);
      return { labels: new Map([[1, 'work']]) };
    },
    listProviderModels: async (provider, context) => {
      const request = { provider, ...context };
      catalogRequests.push(request);
      if (catalogResponse) return catalogResponse(request, catalogRequests.length);
      if (catalogError) throw new Error(catalogError);
      return models;
    },
    LearningCache: { getRules: async () => [], STORAGE_KEY: 'rules' },
    ExactResultCache: { clear: async () => {} },
    chrome: { storage: { sync: makeArea(sync, 'sync'), local: makeArea(local, 'local'), onChanged: { addListener: listener => storageListeners.push(listener) } } },
    document: {
      visibilityState: 'hidden',
      getElementById: id => root.descendants().find(element => element.id === id) || null,
      querySelectorAll: selector => root.querySelectorAll(selector),
      querySelector: selector => root.querySelector(selector),
      createElement: tag => new FakeElement(tag),
      addEventListener(type, listener) { (documentListeners[type] ||= []).push(listener); }
    },
    window: { matchMedia: () => ({ matches: true }), addEventListener() {}, scrollTo() {} },
    location: { hash: '' },
    requestAnimationFrame: callback => callback(),
    setTimeout: () => 0,
    clearTimeout() {},
    clearInterval() {},
    confirm: () => true,
    console: { warn: (...args) => warnings.push(args) }
  });
  vm.runInContext(OPTIONS_SCRIPT, context, { filename: 'options/options.js' });
  await Promise.all((documentListeners.DOMContentLoaded || []).map(listener => listener()));
  await flush();
  assert.deepEqual(warnings, [], 'settings initialization should succeed');
  return {
    root, sync, local, requests, catalogRequests,
    byId: id => context.document.getElementById(id),
    async updateRun(value) { local.foldnex_last_run = value; await emitStorage('foldnex_last_run', value, 'local'); },
    async updateUsage(value) { summary = value; await emitStorage(PROVIDER_USAGE_KEY, value, 'local'); },
    async selectProvider(provider) {
      const radios = root.querySelectorAll('input[name="providerSelect"]');
      radios.forEach(radio => { radio.checked = radio.value === provider; });
      await radios.find(radio => radio.value === provider).fire('change');
    }
  };
}

test('the OpenAI connection test honours the current Priority switch, including an unsaved OFF value', async () => {
  const options = await openOptions({ sync: { provider: 'openai', openaiPriority: true } });
  options.byId('compatibleApiKey').value = 'test-only-key';
  options.byId('prefOpenaiPriority').checked = false;
  await options.byId('btnTestCompatible').fire('click');
  assert.equal(options.requests.length, 1);
  assert.equal(options.requests[0].settings.openaiPriority, false);
  assert.equal(options.sync.openaiPriority, true, 'the request uses the displayed control');
  options.byId('prefOpenaiPriority').checked = true;
  await options.byId('btnTestCompatible').fire('click');
  assert.equal(options.requests[1].settings.openaiPriority, true);
});

test('cloud economy mode defaults OFF, saves both values and applies to remote Ollama', async () => {
  const options = await openOptions();
  assert.equal(options.byId('prefCloudEconomy').checked, false);
  assert.equal(options.byId('cloudCostSettings').classList.contains('hidden'), false);
  options.byId('prefCloudEconomy').checked = true;
  await options.byId('prefCloudEconomy').fire('change');
  assert.equal(options.sync.cloudEconomyMode, true);
  options.byId('prefCloudEconomy').checked = false;
  await options.byId('prefCloudEconomy').fire('change');
  assert.equal(options.sync.cloudEconomyMode, false);
  const remote = await openOptions({ sync: { provider: 'ollama', ollamaBaseUrl: 'http://192.168.1.20:11434/v1', cloudEconomyMode: true } });
  assert.equal(remote.byId('prefCloudEconomy').checked, true);
  assert.equal(remote.byId('cloudCostSettings').classList.contains('hidden'), false);
  const local = await openOptions({ sync: { provider: 'ollama' } });
  assert.equal(local.byId('cloudCostSettings').classList.contains('hidden'), true);
});

test('cached labels with a paid refinement request report cloud usage and reasoning', async () => {
  const run = {
    provider: 'openai', source: 'label-cache', strategy: 'task', model: 'gpt-6',
    modelCalls: { label: 0, naming: 0, consolidation: 1 },
    promptTokens: 120, completionTokens: 25, reasoningTokens: 15, reasoningEffort: 'low'
  };
  const options = await openOptions({ run });
  assert.match(options.byId('diagSource').textContent, /label cache · 1 cloud request/);
  assert.match(options.byId('diagTokens').textContent, /120 in · 25 out/);
  assert.equal(options.byId('diagReasoning').textContent, 'Low');
  assert.equal(options.byId('diagReasoningTokens').textContent, '15');
  await options.updateRun({ ...run, promptTokens: 0, completionTokens: 0, reasoningTokens: null });
  assert.equal(options.byId('diagTokens').textContent, 'Provider usage not reported');
  assert.equal(options.byId('diagReasoningTokens').textContent, 'Not reported');
  await options.updateRun({ provider: 'openai', source: 'label-cache', strategy: 'task', modelCalls: { label: 0, naming: 0, consolidation: 0 } });
  assert.equal(options.byId('diagReasoning').textContent, 'Not used · cached result');
  assert.equal(options.byId('diagReasoningTokens').textContent, 'Not used');
});

test('task diagnostics describe the preferred group target without treating it as a hard ceiling', async () => {
  const options = await openOptions({ run: {
    provider: 'gemini_nano', strategy: 'task', source: 'nano', tabsGrouped: 23,
    groupsCreated: 8, groupCeiling: 6, modelCalls: { label: 1, naming: 0, consolidation: 0 }
  } });
  assert.equal(options.byId('diagOutcome').textContent, '23 tabs · 8 groups · 0 duplicates · preferred target 6');
  assert.doesNotMatch(options.byId('diagOutcome').textContent, /ceiling/);
});

test('shared cloud results record zero new requests while legacy unknown counts remain unknown', async () => {
  const run = {
    provider: 'openai', strategy: 'task', source: 'cloud',
    modelCalls: { label: 0, naming: 0, consolidation: 0 },
    promptTokens: null, completionTokens: null, reasoningTokens: null, reasoningEffort: 'low'
  };
  const options = await openOptions({ run });
  assert.equal(options.byId('diagSource').textContent, 'cloud · shared result · 0 new requests');
  assert.doesNotMatch(options.byId('diagSource').textContent, /cloud request/);
  assert.equal(options.byId('diagTokens').textContent, 'No new request tokens · shared result');
  assert.equal(options.byId('diagReasoning').textContent, 'Low · shared result');
  assert.equal(options.byId('diagReasoningTokens').textContent, 'No new request tokens');
  await options.updateRun({ ...run, reasoningEffort: null });
  assert.equal(options.byId('diagReasoning').textContent, 'Shared result · no new request');

  for (const modelCalls of [undefined, { label: 0 }]) {
    await options.updateRun({ ...run, modelCalls });
    assert.equal(options.byId('diagSource').textContent, 'cloud · request count not recorded');
    assert.equal(options.byId('diagTokens').textContent, 'Provider usage not reported');
    assert.equal(options.byId('diagReasoning').textContent, 'Low');
    assert.equal(options.byId('diagReasoningTokens').textContent, 'Not reported');
  }
  await options.updateRun({ ...run, modelCalls: { label: 1, naming: 0, consolidation: 0 },
    promptTokens: 120, completionTokens: 25, reasoningTokens: 15 });
  assert.equal(options.byId('diagSource').textContent, 'cloud · 1 cloud request');
  assert.equal(options.byId('diagTokens').textContent, '120 in · 25 out · 0 cached');
  assert.equal(options.byId('diagReasoning').textContent, 'Low');
  assert.equal(options.byId('diagReasoningTokens').textContent, '15');
});

test('provider usage updates after late replies independently of Last cleanup and clears separately', async () => {
  const options = await openOptions({ run: { provider: 'openai', source: 'label-cache', strategy: 'task' } });
  const sourceBefore = options.byId('diagSource').textContent;
  await options.updateUsage({
    calls: 3, promptTokens: 400, completionTokens: 50, totalTokens: 450,
    cachedTokens: 200, cacheWriteTokens: 20, reasoningTokens: 10, unknownUsageCalls: 1,
    byProvider: { openai: { calls: 2 }, 'private-title-URL-key': { calls: 1 } }
  });
  assert.equal(options.byId('usageRequests').textContent, '3');
  assert.equal(options.byId('usageTokens').textContent, '400 in · 50 out · 450 total');
  assert.equal(options.byId('usageCache').textContent, '200 read · 20 written');
  assert.equal(options.byId('usageCoverage').textContent, '1 request without token usage');
  assert.equal(options.byId('usageProviders').textContent, 'OpenAI: 2 · Other provider: 1');
  assert.equal(options.byId('diagSource').textContent, sourceBefore);
  await options.byId('btnClearProviderUsage').fire('click');
  assert.equal(options.byId('usageRequests').textContent, '0');
  assert.equal(options.byId('diagSource').textContent, sourceBefore);
});

test('Nano availability does not claim the worker model is already loaded', async () => {
  const options = await openOptions({ sync: { provider: 'gemini_nano' }, nano: 'ready' });
  assert.equal(options.byId('nanoBadge').textContent, 'Available');
  const text = options.byId('nanoStatusText').children
    .map(node => typeof node === 'string' ? node : node.textContent).join('');
  assert.match(text, /Local model available/);
  assert.match(text, /Chrome has downloaded it/);
  assert.match(text, /If it needs loading/);
  assert.match(text, /temporary local groups/);
  assert.doesNotMatch(text, /model ready/);
  assert.equal(options.byId('btnRecheckNano').classList.contains('hidden'), true);
});

test('model catalog and connection test errors never render echoed API credentials', async () => {
  const secret = 'synthetic-provider-echoed-key';
  const error = `HTTP 401: Incorrect API key provided: ${secret}`;
  const openai = await openOptions({ catalogError: error, connectionError: error });
  assert.equal(openai.byId('compatibleModelsStatus').textContent, 'Invalid API key. Check the saved key.');
  assert.doesNotMatch(openai.byId('compatibleModelsStatus').textContent, /synthetic-provider-echoed-key/);
  openai.byId('compatibleApiKey').value = secret;
  await openai.byId('btnTestCompatible').fire('click');
  assert.equal(openai.byId('toast').textContent, 'Invalid API key. Check the saved key.');
  assert.doesNotMatch(openai.byId('toast').textContent, /synthetic-provider-echoed-key/);

  const gemini = await openOptions({ sync: { provider: 'gemini_api' }, catalogError: `Provider body: ${secret}` });
  assert.equal(gemini.byId('geminiModelsStatus').textContent, 'Model catalog request failed. Check the model and provider status.');
  assert.doesNotMatch(gemini.byId('geminiModelsStatus').textContent, /synthetic-provider-echoed-key/);
});

test('full catalog selects show every model independently of the configured text and keep custom models', async () => {
  const models = ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra', 'another-account-model'];
  const options = await openOptions({ sync: { provider: 'openai', openaiModel: 'gpt-6-luna' }, models });
  const picker = options.byId('compatibleModelOptions');
  assert.equal(picker.tagName, 'SELECT');
  assert.deepEqual(picker.children.map(option => option.value), ['', ...models]);
  assert.deepEqual(picker.children.slice(1).map(option => option.textContent), models);
  assert.equal(picker.value, 'gpt-6-luna');
  assert.equal(options.byId('compatibleModel').value, 'gpt-6-luna');
  picker.value = 'gpt-6.1-sol';
  await picker.fire('change');
  assert.equal(options.byId('compatibleModel').value, 'gpt-6.1-sol');
  assert.equal(options.byId('compatibleCustomModel').classList.contains('hidden'), true);
  assert.equal(options.sync.openaiModel, 'gpt-6-luna', 'browsing does not save or change the active model');
  picker.value = '';
  await picker.fire('change');
  assert.equal(options.byId('compatibleCustomModel').classList.contains('hidden'), false);
  options.byId('compatibleModel').value = 'private-deployment-model';
  await options.byId('compatibleModel').fire('input');
  await options.byId('btnSaveCompatible').fire('click');
  assert.equal(options.sync.openaiModel, 'private-deployment-model');
  assert.equal(options.byId('compatibleModel').value, 'private-deployment-model');
  assert.equal(picker.value, '');

  const gemini = await openOptions({ sync: { provider: 'gemini_api', geminiModel: 'custom-gemini-deployment' }, models: ['gemini-flash-a', 'gemini-pro-b'] });
  assert.equal(gemini.byId('geminiModelOptions').tagName, 'SELECT');
  assert.deepEqual(gemini.byId('geminiModelOptions').children.map(option => option.value), ['', 'gemini-flash-a', 'gemini-pro-b']);
  assert.equal(gemini.byId('geminiModel').value, 'custom-gemini-deployment');
  assert.equal(gemini.byId('geminiCustomModel').classList.contains('hidden'), false);
  for (const [key, button] of [['geminiApiKey', 'btnTestGemini'], ['compatibleApiKey', 'btnTestCompatible']]) {
    const row = options.root.querySelectorAll('.api-key-row').find(element => element.descendants().some(child => child.id === key));
    assert.ok(row.descendants().some(child => child.id === button), 'test is adjacent to its key input');
  }
});

test('committed credential and endpoint edits fetch fresh catalogs without trusting old account caches', async () => {
  const options = await openOptions({
    storedLocal: { openaiApiKey: 'synthetic-old-account', openaiModelCatalog: { models: ['stale-account-model'], fetchedAt: Date.now() } },
    catalogResponse: async request => request.apiKey === 'synthetic-new-account' ? ['new-account-model'] : ['fresh-old-account-model']
  });
  assert.equal(options.catalogRequests.length, 1);
  assert.deepEqual(options.byId('compatibleModelOptions').children.map(option => option.value), ['', 'fresh-old-account-model']);
  options.byId('compatibleApiKey').value = 'synthetic-new-account';
  await options.byId('compatibleApiKey').fire('input');
  assert.equal(options.catalogRequests.length, 1, 'typing does not issue requests');
  assert.deepEqual(options.byId('compatibleModelOptions').children.map(option => option.value), ['']);
  await options.byId('compatibleApiKey').fire('change');
  assert.equal(options.catalogRequests.length, 2);
  assert.deepEqual(options.byId('compatibleModelOptions').children.map(option => option.value), ['', 'new-account-model']);
  options.byId('compatibleBaseUrl').value = 'https://another-gateway.example/v1';
  await options.byId('compatibleBaseUrl').fire('input');
  assert.equal(options.catalogRequests.length, 2);
  await options.byId('compatibleBaseUrl').fire('change');
  assert.equal(options.catalogRequests.length, 3);
  assert.equal(options.catalogRequests[2].baseUrl, 'https://another-gateway.example/v1');
  assert.equal(options.local.openaiApiKey, 'synthetic-old-account', 'fetching does not save a draft key');
  assert.deepEqual(options.local.openaiModelCatalog.models, ['stale-account-model'], 'catalog results are page-only');
  assert.equal(options.byId('compatibleModel').value, 'gpt-6-luna', 'refreshing does not select another model');
});

test('successful connection tests refresh catalogs and distinguish a catalog failure from grouping success', async () => {
  const options = await openOptions({ catalogResponse: async (_request, number) => {
    if (number === 2) throw new Error('HTTP 503: synthetic-private-provider-body');
    return number === 1 ? ['initial-model'] : ['refreshed-model', 'another-model'];
  } });
  options.byId('compatibleApiKey').value = 'synthetic-test-key';
  await options.byId('btnTestCompatible').fire('click');
  assert.equal(options.catalogRequests.length, 2);
  assert.equal(options.byId('toast').textContent, 'OpenAI grouping test passed.');
  assert.equal(options.byId('compatibleModelsStatus').textContent, 'Provider returned HTTP 503.');
  assert.deepEqual(options.byId('compatibleModelOptions').children.map(option => option.value), ['']);
  await options.byId('btnTestCompatible').fire('click');
  assert.equal(options.catalogRequests.length, 3);
  assert.deepEqual(options.byId('compatibleModelOptions').children.map(option => option.value), ['', 'refreshed-model', 'another-model']);
  assert.equal(options.byId('compatibleModel').value, 'gpt-6-luna');

  const gemini = await openOptions({ sync: { provider: 'gemini_api' } });
  gemini.byId('geminiApiKey').value = 'synthetic-gemini-key';
  await gemini.byId('geminiApiKey').fire('change');
  assert.equal(gemini.catalogRequests.length, 2);
  await gemini.byId('btnTestGemini').fire('click');
  assert.equal(gemini.catalogRequests.length, 3);
  assert.equal(gemini.byId('toast').textContent, 'Gemini grouping test passed.');
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('late catalogs cannot populate a changed account, endpoint, or provider', async () => {
  for (const change of ['key', 'endpoint', 'provider']) {
    const old = deferred();
    const options = await openOptions({ catalogResponse: async (_request, number) => number === 1 ? old.promise : ['current-scope-model'] });
    if (change === 'provider') await options.selectProvider('xai');
    else {
      const field = options.byId(change === 'key' ? 'compatibleApiKey' : 'compatibleBaseUrl');
      field.value = change === 'key' ? 'synthetic-new-key' : 'https://changed-endpoint.example/v1';
      await field.fire('input');
      await field.fire('change');
    }
    assert.deepEqual(options.byId('compatibleModelOptions').children.map(option => option.value), ['', 'current-scope-model']);
    old.resolve(['obsolete-account-model']);
    await flush();
    assert.deepEqual(options.byId('compatibleModelOptions').children.map(option => option.value), ['', 'current-scope-model'], change);
    assert.equal(options.byId('btnRefreshCompatibleModels').disabled, false);
  }
});

test('late connection success or failure cannot describe a changed configuration or refresh its catalog', async () => {
  for (const outcome of ['success', 'failure', 'model', 'provider', 'reasoning', 'priority']) {
    const result = deferred();
    const options = await openOptions({ connectionResponse: () => result.promise });
    options.byId('compatibleApiKey').value = 'synthetic-original-key';
    const running = options.byId('btnTestCompatible').fire('click');
    await flush();
    if (outcome === 'model') {
      options.byId('compatibleModel').value = 'another-model';
      await options.byId('compatibleModel').fire('input');
    } else if (outcome === 'reasoning') {
      options.byId('compatibleReasoningEffort').value = 'high';
      await options.byId('compatibleReasoningEffort').fire('change');
    } else if (outcome === 'priority') {
      options.byId('prefOpenaiPriority').checked = false;
      await options.byId('prefOpenaiPriority').fire('change');
    } else if (outcome === 'provider') await options.selectProvider('xai');
    else {
      options.byId('compatibleApiKey').value = 'synthetic-changed-key';
      await options.byId('compatibleApiKey').fire('input');
      await options.byId('compatibleApiKey').fire('change');
    }
    const before = options.catalogRequests.length;
    if (outcome === 'failure') result.reject(new Error('HTTP 401: synthetic-old-secret'));
    else result.resolve({ labels: new Map([[1, 'office']]) });
    await running;
    assert.equal(options.catalogRequests.length, before, outcome);
    assert.doesNotMatch(options.byId('toast').textContent, /grouping test passed|Invalid API key|synthetic-old-secret/, outcome);
    assert.equal(options.byId('btnTestCompatible').disabled, false);
  }
});

test('provider fields are unavailable during a pending saved-settings load', async () => {
  const saved = deferred();
  const options = await openOptions({ savedSettingsResponse: async (number, values) => number === 2 ? saved.promise : values });
  for (const id of ['compatibleApiKey', 'compatibleModel', 'compatibleModelOptions', 'compatibleBaseUrl', 'compatibleReasoningEffort', 'prefOpenaiPriority',
    'btnSaveCompatible', 'btnTestCompatible']) {
    assert.equal(options.byId(id).disabled, true, id);
  }
  saved.resolve({ openaiApiKey: 'synthetic-loaded-key', openaiModel: 'saved-model' });
  await flush();
  assert.equal(options.byId('compatibleApiKey').disabled, false);
  assert.equal(options.byId('compatibleModel').value, 'saved-model');
});

test('a provider switch during Save cannot pair the original API key with the new provider endpoint or effort', async () => {
  const gate = deferred();
  const options = await openOptions({ saveSecretsResponse: () => gate.promise });
  options.byId('compatibleApiKey').value = 'synthetic-openai-key';
  options.byId('compatibleBaseUrl').value = 'https://original-openai-gateway.example/v1';
  options.byId('compatibleReasoningEffort').value = 'low';
  const saving = options.byId('btnSaveCompatible').fire('click');
  await flush();
  await options.selectProvider('xai');
  options.byId('compatibleApiKey').value = 'synthetic-xai-key';
  options.byId('compatibleBaseUrl').value = 'https://different-xai-gateway.example/v1';
  options.byId('compatibleReasoningEffort').value = 'high';
  gate.resolve();
  await saving;
  assert.equal(options.local.openaiApiKey, 'synthetic-openai-key');
  assert.equal(options.sync.openaiBaseUrl, 'https://original-openai-gateway.example/v1');
  assert.equal(options.sync.openaiReasoningEffort, 'low');
  assert.equal(options.sync.openaiModel, 'gpt-6-luna');
  assert.equal(options.sync.provider, 'xai');
  assert.equal(options.sync.xaiBaseUrl, undefined, 'switching or typing does not save the other draft');
});
