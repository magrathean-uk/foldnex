import assert from 'node:assert/strict';
import test from 'node:test';

let instance = 0;

function sharedLocks() {
  const queues = new Map();
  return {
    request(name, task) {
      const result = (queues.get(name) || Promise.resolve()).then(task);
      queues.set(name, result.catch(() => {}));
      return result;
    }
  };
}

async function usageHarness(t, { locks = false, record = null } = {}) {
  const originalChrome = globalThis.chrome;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => {
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete globalThis.navigator;
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: locks ? { locks: sharedLocks() } : {} });
  const store = record ? { foldnex_provider_usage_v1: structuredClone(record) } : {};
  globalThis.chrome = { storage: { local: {
    async get(key) {
      // Yield before each operation to expose lost-update races in unsynchronised code.
      await new Promise(resolve => setImmediate(resolve));
      return Object.hasOwn(store, key) ? { [key]: structuredClone(store[key]) } : {};
    },
    async set(values) {
      await new Promise(resolve => setImmediate(resolve));
      Object.assign(store, structuredClone(values));
    }
  } } };
  return { store, module: await import(`../src/provider-usage.js?usage-test=${++instance}`) };
}

for (const useLocks of [false, true]) {
  test(`concurrent provider replies retain every usage total (${useLocks ? 'shared Web Lock' : 'fallback queue'})`, async t => {
    const { module, store } = await usageHarness(t, { locks: useLocks });
    const otherContext = useLocks ? await import(`../src/provider-usage.js?usage-test=${++instance}`) : module;
    const epoch = await module.beginProviderUsage();
    const usage = { promptTokens: 10, completionTokens: 3, totalTokens: 13, cachedTokens: 4, cacheWriteTokens: 2, reasoningTokens: 1 };
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      (index % 2 ? otherContext : module).recordProviderUsage(index % 2 ? 'gemini_api' : 'openai', usage, epoch, 'priority')));
    const summary = await module.readProviderUsageSummary();
    assert.deepEqual(Object.fromEntries(['calls', 'unknownUsageCalls', 'promptTokens', 'completionTokens', 'cachedTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']
      .map(key => [key, summary[key]])), {
      calls: 20, unknownUsageCalls: 0, promptTokens: 200, completionTokens: 60,
      cachedTokens: 80, cacheWriteTokens: 40, reasoningTokens: 20, totalTokens: 260
    });
    assert.equal(summary.byProvider.openai.calls, 10);
    assert.equal(summary.byProvider.gemini_api.calls, 10);
    assert.equal(summary.byProvider.openai.cacheWriteTokens, 20);
    assert.equal(summary.byProvider.gemini_api.reasoningTokens, 10);
    assert.deepEqual(summary.serviceTiers, { priority: 10 });
    assert.equal(store[module.PROVIDER_USAGE_KEY].epoch, epoch);
  });
}

test('only numeric content-free counters and allowed service tiers enter the ledger', async t => {
  const { module, store } = await usageHarness(t);
  const epoch = await module.beginProviderUsage();
  const usage = {
    promptTokens: 12, completionTokens: 5, cachedTokens: 8, cacheWriteTokens: 2, reasoningTokens: 3, totalTokens: 17,
    title: 'synthetic-private-title', url: 'https://synthetic-private.invalid/', apiKey: 'synthetic-secret',
    prompt: 'synthetic-private-prompt', response: 'synthetic-private-response', model: 'synthetic-private-model', debug: { token: 'synthetic-secret' }
  };
  await module.recordProviderUsage('openai', usage, epoch, 'priority');
  await module.recordProviderUsage('openai', null, epoch, 'default');
  await module.recordProviderUsage('openai', { promptTokens: -5, completionTokens: 'secret-value', totalTokens: Infinity, reasoningTokens: 1.2 }, epoch, 'synthetic-secret-tier');
  await module.recordProviderUsage('synthetic-private-provider', usage, epoch, 'priority');
  const summary = await module.readProviderUsageSummary();
  assert.equal(summary.calls, 3);
  assert.equal(summary.unknownUsageCalls, 1);
  assert.equal(summary.promptTokens, 12);
  assert.equal(summary.completionTokens, 5);
  assert.equal(summary.reasoningTokens, 3);
  assert.deepEqual(summary.serviceTiers, { priority: 1, default: 1, unknown: 1 });
  assert.deepEqual(Object.keys(summary.byProvider), ['openai']);
  assert.doesNotMatch(JSON.stringify(store), /synthetic-private|synthetic-secret|secret-value/);
  assert.deepEqual(Object.keys(store[module.PROVIDER_USAGE_KEY]).sort(), ['byProvider', 'epoch', 'serviceTiers', 'totals', 'updatedAt', 'v']);
  assert.deepEqual(Object.keys(store[module.PROVIDER_USAGE_KEY].totals).sort(),
    ['calls', 'unknownUsageCalls', 'promptTokens', 'completionTokens', 'cachedTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'].sort());
});

test('clearing usage drops outstanding old-epoch replies and a new epoch records fresh requests', async t => {
  const { module } = await usageHarness(t, { locks: true });
  const otherContext = await import(`../src/provider-usage.js?usage-test=${++instance}`);
  const oldEpoch = await otherContext.beginProviderUsage();
  await module.recordProviderUsage('openai', { promptTokens: 50, completionTokens: 10, totalTokens: 60 }, oldEpoch, 'priority');
  await module.clearProviderUsage();
  await otherContext.recordProviderUsage('openai', { promptTokens: 999, completionTokens: 111, totalTokens: 1110 }, oldEpoch, 'priority');
  const cleared = await module.readProviderUsageSummary();
  assert.equal(cleared.calls, 0);
  assert.equal(cleared.totalTokens, 0);
  assert.deepEqual(cleared.byProvider, {});
  assert.deepEqual(cleared.serviceTiers, {});
  const newEpoch = await otherContext.beginProviderUsage();
  assert.equal(newEpoch, oldEpoch + 1);
  await otherContext.recordProviderUsage('gemini_api', { promptTokens: 7, completionTokens: 2, totalTokens: 9 }, newEpoch);
  const fresh = await module.readProviderUsageSummary();
  assert.equal(fresh.calls, 1);
  assert.equal(fresh.totalTokens, 9);
  assert.equal(fresh.byProvider.gemini_api.calls, 1);
  assert.deepEqual(fresh.serviceTiers, {});
});

test('summary reads sanitize stored counters, providers and service tier data', async t => {
  const { module } = await usageHarness(t, { record: {
    v: 1, epoch: 2,
    totals: { calls: 2, promptTokens: 15, completionTokens: -1, apiKey: 'synthetic-secret' },
    byProvider: { openai: { calls: 2, promptTokens: 15, title: 'synthetic-private-title' }, 'synthetic-secret-provider': { calls: 1 } },
    serviceTiers: { priority: 1, default: 'synthetic-secret-value', 'synthetic-secret-tier': 9 },
    rawResponse: 'synthetic-private-response'
  } });
  const summary = await module.readProviderUsageSummary();
  assert.equal(summary.calls, 2);
  assert.equal(summary.completionTokens, 0);
  assert.deepEqual(Object.keys(summary.byProvider), ['openai']);
  assert.deepEqual(summary.serviceTiers, { priority: 1, default: 0 });
  assert.doesNotMatch(JSON.stringify(summary), /synthetic-secret|synthetic-private/);
});
