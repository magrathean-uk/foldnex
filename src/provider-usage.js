/** Content-free provider request totals, including late and background work. */
export const PROVIDER_USAGE_KEY = 'foldnex_provider_usage_v1';
const PROVIDERS = new Set(['gemini_api', 'openai', 'xai', 'groq', 'openrouter', 'deepseek', 'cerebras', 'ollama']);
const COUNTERS = ['calls', 'unknownUsageCalls', 'promptTokens', 'completionTokens', 'cachedTokens',
  'cacheWriteTokens', 'reasoningTokens', 'totalTokens'];
let writes = Promise.resolve();
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const counters = value => Object.fromEntries(COUNTERS.map(key => [key, count(value?.[key])]));

function withUsageLock(task) {
  if (globalThis.navigator?.locks?.request) return navigator.locks.request('foldnex-provider-usage', task);
  const result = writes.then(task);
  writes = result.catch(() => {});
  return result;
}

async function readRecord() {
  const value = (await chrome.storage.local.get(PROVIDER_USAGE_KEY))[PROVIDER_USAGE_KEY];
  return value?.v === 1 ? value : { v: 1, epoch: 0, totals: counters(), byProvider: {} };
}

/** Capture before dispatch so clearing totals cannot be undone by a late response. */
export async function beginProviderUsage() {
  if (!globalThis.chrome?.storage?.local) return null;
  await writes;
  return count((await readRecord()).epoch);
}

export async function recordProviderUsage(provider, usage, epoch, serviceTier = null) {
  if (epoch === null || !PROVIDERS.has(provider) || !globalThis.chrome?.storage?.local) return;
  await withUsageLock(async () => {
    const record = await readRecord();
    if (count(record.epoch) !== epoch) return;
    const delta = counters({ ...usage, calls: 1, unknownUsageCalls: usage ? 0 : 1 });
    const add = before => Object.fromEntries(COUNTERS.map(key => [key,
      Math.min(Number.MAX_SAFE_INTEGER, count(before?.[key]) + delta[key])]));
    const byProvider = Object.fromEntries(Object.entries(record.byProvider || {})
      .filter(([key]) => PROVIDERS.has(key)).map(([key, value]) => [key, counters(value)]));
    byProvider[provider] = add(byProvider[provider]);
    const tiers = Object.fromEntries(Object.entries(record.serviceTiers || {})
      .filter(([key]) => ['default', 'priority', 'fast', 'flex', 'auto', 'unknown'].includes(key))
      .map(([key, value]) => [key, count(value)]));
    if (provider === 'openai') {
      const tier = ['default', 'priority', 'fast', 'flex', 'auto'].includes(serviceTier) ? serviceTier : 'unknown';
      tiers[tier] = count(tiers[tier]) + 1;
    }
    await chrome.storage.local.set({ [PROVIDER_USAGE_KEY]: {
      v: 1, epoch, totals: add(record.totals), byProvider, serviceTiers: tiers, updatedAt: Date.now()
    } });
  });
}

export async function readProviderUsageSummary() {
  if (!globalThis.chrome?.storage?.local) return { ...counters(), byProvider: {}, serviceTiers: {} };
  await writes;
  const record = await readRecord();
  return { ...counters(record.totals), byProvider: Object.fromEntries(Object.entries(record.byProvider || {})
    .filter(([key]) => PROVIDERS.has(key)).map(([key, value]) => [key, counters(value)])),
  serviceTiers: Object.fromEntries(Object.entries(record.serviceTiers || {})
    .filter(([key]) => ['default', 'priority', 'fast', 'flex', 'auto', 'unknown'].includes(key))
    .map(([key, value]) => [key, count(value)])), updatedAt: count(record.updatedAt) };
}

export async function clearProviderUsage() {
  await withUsageLock(async () => {
    const record = await readRecord();
    await chrome.storage.local.set({ [PROVIDER_USAGE_KEY]: {
      v: 1, epoch: count(record.epoch) + 1, totals: counters(), byProvider: {}, serviceTiers: {}
    } });
  });
}
