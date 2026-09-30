import assert from 'node:assert/strict';
import test from 'node:test';

import { consolidateWithCloud, labelCacheScope, labelTabsWithAI } from '../src/ai-engine.js';
import { TabLabelCache } from '../src/cache-engine.js';
import { createClickBudget, getRunScope, groupByLabels, labelOnClick } from '../src/grouper.js';
import { PROVIDER_USAGE_KEY, readProviderUsageSummary } from '../src/provider-usage.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const settings = { provider: 'openai', openaiApiKey: 'synthetic-test-key', openaiPriority: false };
const usage = {
  prompt_tokens: 100, completion_tokens: 12, total_tokens: 112,
  prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 5 }
};

function tabs(ids = [1, 2, 3]) {
  return ids.map((id, index) => ({
    id, windowId: 1, index, incognito: false, pinned: false,
    title: ['React hooks reference', 'Tokyo flights and hotel', 'Ramen recipe ingredients'][index % 3],
    url: `https://topic-${index}.example/article/${index}`
  }));
}

function category(title) {
  return /React/.test(title) ? 'dev' : /Tokyo|flight/.test(title) ? 'travel' : 'food';
}

function installStorage() {
  const local = {};
  const area = store => ({
    async get(keys) {
      if (keys == null) return structuredClone(store);
      return Object.fromEntries([].concat(keys).filter(key => key in store).map(key => [key, structuredClone(store[key])]));
    },
    async set(values) { Object.assign(store, structuredClone(values)); },
    async remove(keys) { for (const key of [].concat(keys)) delete store[key]; }
  });
  globalThis.chrome = { storage: { local: area(local), sync: area({}), session: area({}) } };
  return local;
}

async function waitFor(check, label) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(2);
  }
  assert.fail(`Timed out: ${label}`);
}

/** Controlled HTTP boundary: every response is synthetic and can be held open. */
function installProvider({ hold = true, returnedTier = null } = {}) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    const prompt = payload.messages?.at(-1)?.content || payload.contents?.[0]?.parts?.[0]?.text;
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
    const kind = input.tabs ? 'label' : 'consolidate';
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const request = { url, payload, kind, rows: input.tabs || input.rows, signal: options.signal, release };
    requests.push(request);
    if (hold) await gate;
    const answer = kind === 'label'
      ? Object.fromEntries(request.rows.map(([id, title]) => [id, category(title)]))
      : { folders: request.rows.map(([id, dominant]) => ({ name: `${dominant} topics`, ids: [id] })) };
    const gemini = Boolean(payload.contents);
    return { ok: true, async json() {
      return gemini
        ? { candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 12, totalTokenCount: 112, cachedContentTokenCount: 20, thoughtsTokenCount: 5 } }
        : { model: payload.model, choices: [{ message: { content: JSON.stringify(answer) } }], usage, service_tier: returnedTier ?? payload.service_tier };
    } };
  };
  return {
    requests,
    releaseAll() { for (const request of requests) request.release(); },
    restore() { for (const request of requests) request.release(); globalThis.fetch = original; }
  };
}

test('overlapping label consumers remap fingerprints to their own IDs and account for one actual request', async () => {
  installStorage();
  const provider = installProvider();
  const firstTabs = tabs([10, 11]);
  const secondTabs = firstTabs.map(tab => ({ ...tab, id: tab.id + 100 }));
  try {
    const first = labelTabsWithAI(firstTabs, settings);
    await waitFor(() => provider.requests.length === 1, 'owner dispatch');
    const second = labelTabsWithAI(secondTabs, settings);
    await pause(25);
    assert.equal(provider.requests.length, 1);
    provider.releaseAll();
    const [owner, consumer] = await Promise.all([first, second]);
    assert.deepEqual([...owner.labels], [[10, 'dev'], [11, 'travel']]);
    assert.deepEqual([...consumer.labels], [[110, 'dev'], [111, 'travel']]);
    assert.equal(owner.meta.calls, 1);
    assert.equal(consumer.meta.calls, 0);
    assert.equal(consumer.meta.usage, null);
    const totals = await readProviderUsageSummary();
    assert.equal(totals.calls, 1);
    assert.equal(totals.promptTokens, 100);
    assert.equal(totals.cachedTokens, 20);
    assert.equal(totals.completionTokens, 12);
    assert.equal(totals.reasoningTokens, 5);
  } finally { provider.restore(); }
});

test('a dispatched HTTP 401 keeps its label-call count while falling back without known usage', async () => {
  installStorage();
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return { ok: false, status: 401, async json() { return { error: { message: 'Synthetic authentication failure' } }; } };
  };
  try {
    const result = await groupByLabels(tabs(), [], settings);
    assert.equal(requests, 1);
    assert.equal(result.modelCalls.label, 1);
    assert.equal(result.meta.calls, 1);
    assert.equal(result.meta.provider, 'openai');
    assert.equal(result.meta.model, 'gpt-6-luna');
    assert.equal(result.meta.reasoningEffort, 'low');
    assert.ok(result.meta.latencyMs >= 0);
    assert.equal(result.meta.usage, null);
    assert.equal(result.fallbackCode, 'auth');
    assert.equal(result.source, 'offline-fallback');
    assert.equal(result.persist.labels.size, 0);
    assert.equal(result.provisionalTabIds.length, 3);
    const cumulative = await readProviderUsageSummary();
    assert.equal(cumulative.calls, 1);
    assert.equal(cumulative.unknownUsageCalls, 1);
  } finally { globalThis.fetch = original; }
});

test('missing credentials and unsupported provider settings fail before dispatch and count zero calls', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; assert.fail('Preflight failures must not send HTTP requests'); };
  try {
    for (const invalid of [
      { provider: 'openai' },
      { provider: 'gemini_api' },
      { ...settings, openaiModel: 'gpt-5.5-pro' },
      { provider: 'unsupported-provider' }
    ]) {
      installStorage();
      const result = await groupByLabels(tabs(), [], invalid);
      assert.equal(result.modelCalls.label, 0);
      assert.equal(result.meta.calls, 0);
      assert.equal(result.meta.reasoningEffort, null);
      assert.equal(result.meta.usage, null);
      assert.equal(result.source, 'offline-fallback');
      assert.equal((await readProviderUsageSummary()).calls, 0);
    }
    assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
});

test('a shared failed label request counts its owner once and its waiting cleanup zero times', async () => {
  installStorage();
  const original = globalThis.fetch;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    await gate;
    return { ok: false, status: 401, async json() { return { error: { message: 'Synthetic authentication failure' } }; } };
  };
  try {
    const list = tabs();
    const owner = groupByLabels(list, [], settings);
    await waitFor(() => requests === 1, 'owner authentication request');
    const waiter = groupByLabels(list.map(tab => ({ ...tab, id: tab.id + 100 })), [], settings);
    await pause(25);
    release();
    const [first, second] = await Promise.all([owner, waiter]);
    assert.equal(requests, 1);
    assert.equal(first.modelCalls.label, 1);
    assert.equal(second.modelCalls.label, 0);
    assert.equal(first.fallbackCode, 'auth');
    assert.equal(second.fallbackCode, 'auth');
    assert.equal(first.meta.usage, null);
    assert.equal(second.meta.usage, null);
    assert.equal((await readProviderUsageSummary()).calls, 1);
  } finally { release(); globalThis.fetch = original; }
});

test('consolidation preflight failures and aborted requests never notify a dispatch', async () => {
  installStorage();
  const original = globalThis.fetch;
  let requests = 0;
  let dispatches = 0;
  globalThis.fetch = async () => { requests++; assert.fail('Preflight failures must not send HTTP requests'); };
  const candidates = [
    { key: 'cat:dev', dominant: 'dev', tabIds: [1] },
    { key: 'cat:travel', dominant: 'travel', tabIds: [2] }
  ];
  try {
    await assert.rejects(consolidateWithCloud(candidates, 2, { provider: 'openai' }, { onDispatch: () => { dispatches++; } }), /API key is not configured/);
    const controller = new AbortController();
    controller.abort(new Error('Synthetic cancellation'));
    await assert.rejects(consolidateWithCloud(candidates, 2, settings, { signal: controller.signal, onDispatch: () => { dispatches++; } }), /Synthetic cancellation/);
    assert.equal(requests, 0);
    assert.equal(dispatches, 0);
  } finally { globalThis.fetch = original; }
});

test('a schema retry counts one logical label dispatch and both HTTP attempts in cumulative usage', async () => {
  installStorage();
  const original = globalThis.fetch;
  let requests = 0;
  let dispatches = 0;
  globalThis.fetch = async (_url, options) => {
    requests++;
    const payload = JSON.parse(options.body);
    if (requests === 1) {
      assert.equal(payload.response_format.type, 'json_schema');
      return { ok: false, status: 400, async json() { return { error: { message: 'Synthetic unsupported response_format', param: 'response_format' } }; } };
    }
    assert.equal(payload.response_format.type, 'json_object');
    return { ok: true, async json() {
      return { model: payload.model, choices: [{ message: { content: '{"0":"dev","1":"travel","2":"food"}' } }], usage };
    } };
  };
  try {
    const result = await labelTabsWithAI(tabs(), settings, { onDispatch: () => { dispatches++; } });
    assert.equal(result.labels.size, 3);
    assert.equal(result.meta.calls, 1);
    assert.equal(dispatches, 1);
    assert.equal(requests, 2);
    const cumulative = await readProviderUsageSummary();
    assert.equal(cumulative.calls, 2);
    assert.equal(cumulative.unknownUsageCalls, 1);
    assert.equal(cumulative.promptTokens, usage.prompt_tokens);
  } finally { globalThis.fetch = original; }
});

test('partial overlap sends only new fingerprints while preserving both caller assignments', async () => {
  installStorage();
  const provider = installProvider();
  const all = tabs([20, 21, 22]);
  try {
    const first = labelTabsWithAI(all.slice(0, 2), settings);
    await waitFor(() => provider.requests.length === 1, 'initial labels');
    const second = labelTabsWithAI([ { ...all[1], id: 121 }, all[2] ], settings);
    await waitFor(() => provider.requests.length === 2, 'new fingerprint');
    assert.deepEqual(provider.requests.map(request => request.rows.length), [2, 1]);
    assert.equal(provider.requests[1].rows[0][1], all[2].title);
    provider.releaseAll();
    const [owner, consumer] = await Promise.all([first, second]);
    assert.deepEqual([...owner.labels], [[20, 'dev'], [21, 'travel']]);
    assert.deepEqual([...consumer.labels], [[121, 'travel'], [22, 'food']]);
    assert.equal(consumer.meta.calls, 1);
    assert.equal((await readProviderUsageSummary()).calls, 2);
  } finally { provider.restore(); }
});

test('canceling a shared label consumer leaves its owner request running', async () => {
  installStorage();
  const provider = installProvider();
  const controller = new AbortController();
  try {
    const owner = labelTabsWithAI(tabs([30, 31]), settings);
    await waitFor(() => provider.requests.length === 1, 'owner labels');
    const consumer = labelTabsWithAI(tabs([130, 131]), settings, { signal: controller.signal });
    await pause(10);
    controller.abort(new Error('Consumer canceled'));
    assert.equal((await consumer).aborted, true);
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0].signal.aborted, false);
    provider.releaseAll();
    assert.equal((await owner).labels.size, 2);
    assert.equal((await readProviderUsageSummary()).calls, 1);
  } finally { provider.restore(); }
});

test('learning epochs and provider configuration changes cannot share active labels', async () => {
  const local = installStorage();
  const provider = installProvider();
  const list = tabs([40, 41]);
  try {
    const running = [labelTabsWithAI(list, settings, { epoch: 0 })];
    await waitFor(() => provider.requests.length === 1, 'original configuration');
    local.foldnex_reset_epoch = 1;
    const variants = [
      [settings, 1],
      [{ ...settings, openaiModel: 'gpt-4o' }, 0],
      [{ ...settings, openaiBaseUrl: 'https://synthetic-gateway.example/v1' }, 0],
      [{ provider: 'xai', xaiApiKey: 'synthetic-test-key' }, 0]
    ];
    for (const [variant, epoch] of variants) running.push(labelTabsWithAI(list, variant, { epoch }));
    await waitFor(() => provider.requests.length === 5, 'configuration-specific requests');
    provider.releaseAll();
    assert.ok((await Promise.all(running)).every(result => result.labels.size === 2 && result.meta.calls === 1));
    const totals = await readProviderUsageSummary();
    assert.equal(totals.calls, 5);
    assert.equal(totals.byProvider.openai.calls, 4);
    assert.equal(totals.byProvider.xai.calls, 1);
  } finally { provider.restore(); }
});

test('incognito label requests are neither shared nor written into the usage ledger', async () => {
  const local = installStorage();
  const provider = installProvider();
  const privateTabs = tabs([50, 51]).map(tab => ({ ...tab, incognito: true }));
  try {
    const first = labelTabsWithAI(privateTabs, settings);
    const second = labelTabsWithAI(privateTabs.map(tab => ({ ...tab, id: tab.id + 100 })), settings);
    await waitFor(() => provider.requests.length === 2, 'independent private requests');
    provider.releaseAll();
    const results = await Promise.all([first, second]);
    assert.ok(results.every(result => result.labels.size === 2 && result.meta.calls === 1));
    assert.equal((await readProviderUsageSummary()).calls, 0);
    assert.ok(!(PROVIDER_USAGE_KEY in local));
  } finally { provider.restore(); }
});

test('overlapping consolidation shares one fetch while a canceled consumer leaves the owner intact', async () => {
  installStorage();
  const provider = installProvider();
  const list = tabs([60, 61]);
  const candidates = list.map((tab, index) => ({ dominant: index ? 'travel' : 'dev', tabIds: [tab.id] }));
  const tabsById = new Map(list.map(tab => [tab.id, tab]));
  const controller = new AbortController();
  try {
    const owner = consolidateWithCloud(candidates, 2, settings, { tabsById });
    await waitFor(() => provider.requests.length === 1, 'owner consolidation');
    const consumer = consolidateWithCloud(candidates, 2, settings, { tabsById });
    const canceled = consolidateWithCloud(candidates, 2, settings, { tabsById, signal: controller.signal });
    const rejection = assert.rejects(canceled, /Consumer canceled/);
    await pause(10);
    controller.abort(new Error('Consumer canceled'));
    await rejection;
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0].signal.aborted, false);
    provider.releaseAll();
    const [first, second] = await Promise.all([owner, consumer]);
    assert.deepEqual(first.folders, second.folders);
    assert.equal(first.meta.calls, 1);
    assert.equal(second.meta.calls, 0);
    assert.equal(second.meta.usage, null);
    assert.equal((await readProviderUsageSummary()).calls, 1);
  } finally { provider.restore(); }
});

test('private consolidation context disables active sharing and durable accounting', async () => {
  const local = installStorage();
  const provider = installProvider();
  const list = tabs([65, 66]).map(tab => ({ ...tab, incognito: true }));
  const candidates = list.map((tab, index) => ({ dominant: index ? 'travel' : 'dev', tabIds: [tab.id] }));
  const context = { tabsById: new Map(list.map(tab => [tab.id, tab])), recordUsage: false };
  try {
    const first = consolidateWithCloud(candidates, 2, settings, context);
    const second = consolidateWithCloud(candidates, 2, settings, context);
    await waitFor(() => provider.requests.length === 2, 'independent private refinements');
    provider.releaseAll();
    assert.ok((await Promise.all([first, second])).every(result => result.meta.calls === 1));
    assert.equal((await readProviderUsageSummary()).calls, 0);
    assert.ok(!(PROVIDER_USAGE_KEY in local));
  } finally { provider.restore(); }
});

test('Priority off sends an explicit default tier and records the returned service tier', async () => {
  installStorage();
  const provider = installProvider({ hold: false, returnedTier: 'flex' });
  try {
    await labelTabsWithAI(tabs([70]), settings);
    await labelTabsWithAI(tabs([70]), { ...settings, openaiPriority: true });
    assert.deepEqual(provider.requests.map(request => request.payload.service_tier), ['default', 'priority']);
    assert.deepEqual((await readProviderUsageSummary()).serviceTiers, { flex: 2 });
  } finally { provider.restore(); }
});

test('Gemini labels cap total output and retain the selected supported thinking effort', async () => {
  installStorage();
  const provider = installProvider({ hold: false });
  try {
    for (const effort of ['low', 'medium', 'high']) {
      await labelTabsWithAI(tabs([80, 81, 82]), {
        provider: 'gemini_api', geminiApiKey: 'synthetic-test-key',
        geminiModel: 'gemini-3-flash', geminiReasoningEffort: effort
      });
    }
    assert.deepEqual(provider.requests.map(request => request.payload.generationConfig.maxOutputTokens), [768, 1152, 1536]);
    assert.deepEqual(provider.requests.map(request => request.payload.generationConfig.thinkingConfig.thinkingLevel), ['LOW', 'MEDIUM', 'HIGH']);
    assert.ok(provider.requests.every(request => request.payload.generationConfig.responseMimeType === 'application/json'));
    const totals = await readProviderUsageSummary();
    assert.equal(totals.calls, 3);
    assert.equal(totals.byProvider.gemini_api.reasoningTokens, 15);
  } finally { provider.restore(); }
});

test('Gemini 2.5 output caps reserve the selected thinking budget plus the JSON answer', async () => {
  installStorage();
  const provider = installProvider({ hold: false });
  try {
    for (const effort of ['low', 'medium', 'high']) {
      await labelTabsWithAI(tabs([85, 86, 87]), {
        provider: 'gemini_api', geminiApiKey: 'synthetic-test-key',
        geminiModel: 'gemini-2.5-flash', geminiReasoningEffort: effort
      });
    }
    const configs = provider.requests.map(request => request.payload.generationConfig);
    assert.deepEqual(configs.map(config => config.thinkingConfig.thinkingBudget), [512, 8192, 24576]);
    assert.deepEqual(configs.map(config => config.maxOutputTokens), [1280, 9344, 26112]);
    assert.ok(configs.every(config => config.maxOutputTokens > config.thinkingConfig.thinkingBudget));
  } finally { provider.restore(); }
});

test('a cloud response arriving after the cleanup deadline still warms labels and records actual usage', async () => {
  installStorage();
  const provider = installProvider();
  const list = tabs([90, 91]);
  const scope = labelCacheScope(settings);
  const { fingerprintById } = await TabLabelCache.lookup(list, { scope });
  const budget = createClickBudget(650);
  try {
    const click = labelOnClick(list, settings, { budget, fingerprintById });
    await waitFor(() => provider.requests.length === 1, 'slow cleanup request');
    const immediate = await click;
    assert.equal(immediate.deadlineHit, true);
    assert.equal(immediate.labels.size, 0);
    assert.equal(provider.requests[0].signal.aborted, false);
    assert.equal((await readProviderUsageSummary()).calls, 0);
    provider.releaseAll();
    await waitFor(async () => (await readProviderUsageSummary()).calls === 1, 'late usage accounting');
    await waitFor(async () => (await TabLabelCache.lookup(list, { scope })).missing.length === 0, 'late label persistence');
    assert.equal((await readProviderUsageSummary()).completionTokens, 12);
  } finally { budget.dispose(); provider.restore(); }
});

test('a shared consolidation that misses both cleanup deadlines counts only its owner request', async () => {
  installStorage();
  const provider = installProvider();
  const list = Array.from({ length: 9 }, (_, index) => ({ ...tabs([index + 300])[0],
    title: tabs()[index % 3].title, url: `https://prepared-${index}.example/article/${index}`, index
  }));
  const scope = labelCacheScope(settings);
  const { fingerprintById } = await TabLabelCache.lookup(list, { scope });
  await TabLabelCache.store(new Map(list.map(tab => [tab.id, category(tab.title)])), fingerprintById, 'openai', { scope });
  const shortWait = () => { let reads = 0; return { remaining: () => ++reads === 1 ? 1600 : 610 }; };
  try {
    const first = await groupByLabels(list, [], settings, { budget: shortWait() });
    const second = await groupByLabels(list, [], settings, { budget: shortWait() });
    assert.ok(first.qualityFlags.includes('consolidation_timeout'));
    assert.ok(second.qualityFlags.includes('consolidation_timeout'));
    assert.equal(provider.requests.length, 1);
    assert.equal(first.modelCalls.consolidation, 1);
    assert.equal(second.modelCalls.consolidation, 0);
    provider.releaseAll();
    await waitFor(async () => (await readProviderUsageSummary()).calls === 1, 'shared refinement usage');
    await pause(5);
  } finally { provider.releaseAll(); provider.restore(); }
});

test('cloud economy skips refinement while the default retains it and local Ollama remains refined', async () => {
  installStorage();
  const provider = installProvider({ hold: false });
  const list = Array.from({ length: 9 }, (_, index) => ({ ...tabs([index + 100])[0],
    title: tabs()[index % 3].title, url: `https://topic-${index}.example/article/${index}`, index
  }));
  const scope = labelCacheScope(settings);
  const { fingerprintById } = await TabLabelCache.lookup(list, { scope });
  await TabLabelCache.store(new Map(list.map(tab => [tab.id, category(tab.title)])), fingerprintById, 'openai', { scope });
  try {
    const economical = await groupByLabels(list, [], { ...settings, cloudEconomyMode: true });
    assert.equal(provider.requests.length, 0);
    assert.equal(economical.modelCalls.consolidation, 0);
    assert.equal(economical.labelSources.cache, 9);
    const refined = await groupByLabels(list, [], settings);
    assert.equal(provider.requests.filter(request => request.kind === 'consolidate').length, 1);
    assert.equal(refined.modelCalls.consolidation, 1);
    assert.equal(refined.labelSources.cache, 9);
    assert.notEqual(getRunScope(settings).cacheScope, getRunScope({ ...settings, cloudEconomyMode: true }).cacheScope);

    const local = { provider: 'ollama', cloudEconomyMode: true };
    // Each selected engine has prepared labels of its own; OpenAI labels
    // no longer populate Ollama's semantic classification cache.
    await TabLabelCache.store(new Map(list.map(tab => [tab.id, category(tab.title)])), fingerprintById, 'ollama', { scope: labelCacheScope(local) });
    const onDevice = await groupByLabels(list, [], local);
    assert.equal(provider.requests.length, 2);
    assert.equal(onDevice.modelCalls.consolidation, 1);
    assert.ok(provider.requests[1].url.startsWith('http://localhost:11434/'));
    assert.equal(getRunScope(local).cacheScope, getRunScope({ ...local, cloudEconomyMode: false }).cacheScope);
    for (const result of [economical, refined, onDevice]) {
      assert.deepEqual(result.groups.flatMap(group => group.tabIds).sort((a, b) => a - b), list.map(tab => tab.id));
    }
  } finally { provider.restore(); }
});
