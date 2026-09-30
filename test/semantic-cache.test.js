import assert from 'node:assert/strict';
import test from 'node:test';

import { assessGroupingQuality, groupCeiling, labelCacheScope, MAX_GROUPS } from '../src/ai-engine.js';
import { ExactResultCache, PlanMemory, TabLabelCache, WindowPlanStore, hashToken, readResetEpoch } from '../src/cache-engine.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function installStorage() {
  const local = {};
  const session = {};
  const makeArea = store => ({
    async get(keys) {
      const selected = Array.isArray(keys) ? keys : keys == null ? Object.keys(store) : [keys];
      return structuredClone(Object.fromEntries(selected.filter(key => key in store).map(key => [key, store[key]])));
    },
    async set(values) { Object.assign(store, structuredClone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]; }
  });
  globalThis.chrome = {
    storage: {
      local: makeArea(local),
      session: makeArea(session)
    }
  };
  return local;
}

const tab = { id: 1, windowId: 1, title: 'A useful page', url: 'https://example.test/page' };
const openai = { provider: 'openai', openaiModel: 'gpt-6-luna', openaiReasoningEffort: 'low' };

test('semantic scope changes with engine, model, effective effort and endpoint, never credentials or priority', () => {
  const original = labelCacheScope(openai);
  assert.equal(original, labelCacheScope({ ...openai, openaiApiKey: 'one-test-secret', openaiOAuthToken: 'another-test-secret', openaiPriority: false, cloudEconomyMode: true }));
  assert.equal(original, labelCacheScope({ ...openai, openaiBaseUrl: 'https://api.openai.com/v1/' }));
  assert.equal(original, labelCacheScope({ ...openai, openaiBaseUrl: 'https://user:password@api.openai.com/v1?token=secret#fragment' }));
  assert.notEqual(original, labelCacheScope({ ...openai, openaiBaseUrl: 'https://alternative.test/v1' }));
  assert.notEqual(original, labelCacheScope({ ...openai, openaiModel: 'gpt-6-sol' }));
  assert.notEqual(original, labelCacheScope({ ...openai, openaiReasoningEffort: 'high' }));
  assert.notEqual(original, labelCacheScope({ provider: 'gemini_nano' }));
  // Unsupported effort preferences normalize to the same actual request.
  assert.equal(labelCacheScope({ provider: 'ollama', ollamaModel: 'qwen2.5-coder:32b', ollamaReasoningEffort: 'high' }), labelCacheScope({ provider: 'ollama', ollamaModel: 'qwen2.5-coder:32b' }));
  assert.ok(!original.includes('https:'));
});

test('distinct subjects may exceed the preferred target without a too-many-groups failure', () => {
  const groups = Array.from({ length: 9 }, (_, index) => ({ name: `Subject ${index}`, tabIds: [index * 2, index * 2 + 1] }));
  assert.ok(groups.length > groupCeiling(18));
  assert.ok(!assessGroupingQuality(groups, 18).codes.includes('too_many'));
  assert.ok(assessGroupingQuality([...groups, ...Array.from({ length: MAX_GROUPS + 1 - groups.length }, (_, index) => ({ name: `Extra ${index}`, tabIds: [40 + index] }))], 18).codes.includes('too_many'));
});

test('switching A to B to A reuses the correct labels and late A results cannot overwrite B', async () => {
  installStorage();
  const a = labelCacheScope(openai);
  const b = labelCacheScope({ ...openai, openaiReasoningEffort: 'high' });
  const { fingerprintById } = await TabLabelCache.lookup([tab], { scope: a });
  await TabLabelCache.store(new Map([[1, 'ai']]), fingerprintById, 'openai', { scope: a });
  assert.equal((await TabLabelCache.lookup([tab], { scope: b })).missing.length, 1);
  await TabLabelCache.store(new Map([[1, 'dev']]), fingerprintById, 'openai', { scope: b });
  // Simulate a slow earlier request completing after the B request.
  await TabLabelCache.store(new Map([[1, 'learn']]), fingerprintById, 'openai', { scope: a });
  assert.equal((await TabLabelCache.lookup([tab], { scope: b })).labels.get(1).c, 'dev');
  const returnedToA = await TabLabelCache.lookup([{ ...tab, id: 99, windowId: 9 }], { scope: a });
  assert.equal(returnedToA.missing.length, 0);
  assert.equal(returnedToA.labels.get(99).c, 'learn');
});

test('new semantic scopes reassess legacy labels and preserve incognito and reset boundaries', async () => {
  const local = installStorage();
  const scope = labelCacheScope(openai);
  const { fingerprintById } = await TabLabelCache.lookup([tab]);
  await TabLabelCache.store(new Map([[1, 'ai']]), fingerprintById, 'openai');
  assert.equal((await TabLabelCache.lookup([tab], { scope })).missing.length, 1);
  const origin = await readResetEpoch();
  local.foldnex_reset_epoch = origin + 1;
  await TabLabelCache.store(new Map([[1, 'dev']]), fingerprintById, 'openai', { epoch: origin, scope });
  assert.equal((await TabLabelCache.lookup([tab], { scope })).missing.length, 1);
  const privateLookup = await TabLabelCache.lookup([{ ...tab, incognito: true }], { scope });
  assert.equal(privateLookup.fingerprintById.size, 0);
  await TabLabelCache.store(new Map([[1, 'ai']]), privateLookup.fingerprintById, 'openai', { scope });
  assert.equal((await TabLabelCache.lookup([tab], { scope })).labels.size, 0);
});

test('labels keep a total bound across semantic scopes', async () => {
  installStorage();
  const fingerprintById = new Map(Array.from({ length: 1600 }, (_, index) => [index, `fingerprint-${index}`]));
  const labels = new Map([...fingerprintById.keys()].map(id => [id, 'dev']));
  await TabLabelCache.store(labels, fingerprintById, 'openai', { scope: 'scope-a' });
  await TabLabelCache.store(labels, fingerprintById, 'openai', { scope: 'scope-b' });
  assert.equal(Object.keys(await TabLabelCache.read()).length, 3000);
});

test('exact results retain semantic categories and provenance through ID remapping without raw page data', async () => {
  const local = installStorage();
  const tabs = [tab, { ...tab, id: 2, title: 'A second useful page', url: 'https://second.test/page' }];
  const scope = labelCacheScope(openai);
  const context = await ExactResultCache.makeContext(tabs, scope);
  const group = {
    name: 'Code & AI', color: 'cyan', tabIds: [1, 2], key: 'cat:dev', keys: ['cat:dev', 'cat:ai'],
    categories: ['dev', 'ai'], dominant: 'dev', kind: 'folder', locked: false, nameSource: 'model',
    titles: tabs.map(item => item.title), urls: tabs.map(item => item.url), entries: [{ title: 'raw-title', url: 'raw-url' }]
  };
  await ExactResultCache.put(context, [group]);
  const hit = await ExactResultCache.get(tabs.map(item => ({ ...item, id: item.id + 100 })), scope);
  assert.deepEqual(hit.groups, [{
    name: 'Code & AI', color: 'cyan', tabIds: [101, 102], key: 'cat:dev', keys: ['cat:ai', 'cat:dev'],
    categories: ['dev', 'ai'], dominant: 'dev', kind: 'folder', locked: false, nameSource: 'model'
  }]);
  const stored = JSON.stringify(local[ExactResultCache.STORAGE_KEY]);
  assert.ok(!stored.includes(tab.title));
  assert.ok(!stored.includes(tab.url));
  assert.ok(!stored.includes('raw-title'));
});

test('session plans retain minority categories, locks and user name provenance without page payloads', async () => {
  installStorage();
  const group = {
    name: 'My Folder', color: 'blue', tabIds: [1, 2], key: 'cat:dev', keys: ['cat:dev', 'cat:ai'],
    categories: ['dev', 'ai', 'unknown'], dominant: 'dev', kind: 'folder', locked: true, nameSource: 'memory-user',
    titles: ['raw-title'], url: 'https://secret.test/page', tokens: ['raw-token']
  };
  await WindowPlanStore.put(1, { K: 6, signature: 'semantic', groups: [group] });
  const stored = await WindowPlanStore.get(1);
  assert.deepEqual(stored.groups, [{
    name: 'My Folder', color: 'blue', tabIds: [1, 2], key: 'cat:dev', keys: ['cat:ai', 'cat:dev'],
    categories: ['dev', 'ai'], dominant: 'dev', kind: 'folder', locked: true, nameSource: 'memory-user'
  }]);
  assert.ok(!JSON.stringify(stored).includes('raw-'));
  assert.ok(!JSON.stringify(stored).includes('https:'));
});

test('model names and advice follow their scope while user renames remain global', async () => {
  installStorage();
  const a = labelCacheScope(openai);
  const b = labelCacheScope({ provider: 'gemini_api' });
  const record = { k: ['cat:ai'], w: [hashToken('topic')], n: 'Legacy Name', s: 'cloud' };
  await PlanMemory.putNames([record]);
  await PlanMemory.putAdvice({ 'cat:shop': 'cat:ai' });
  await PlanMemory.putNames([{ ...record, n: 'OpenAI Name' }], { scope: a });
  await PlanMemory.putAdvice({ 'cat:dev': 'cat:ai' }, { scope: a });
  await PlanMemory.putNames([{ ...record, n: 'Gemini Name' }], { scope: b });
  await PlanMemory.putAdvice({ 'cat:learn': 'cat:ai' }, { scope: b });
  await PlanMemory.recordUserRename({ tabs: [tab], name: 'My Name', keys: ['cat:ai'], color: 'blue' });
  assert.deepEqual((await PlanMemory.read({ scope: a })).names.map(item => item.n).sort(), ['My Name', 'OpenAI Name']);
  assert.deepEqual((await PlanMemory.read({ scope: b })).names.map(item => item.n).sort(), ['Gemini Name', 'My Name']);
  assert.deepEqual((await PlanMemory.read({ scope: a })).advice.cloud, { 'cat:dev': 'cat:ai' });
  assert.deepEqual((await PlanMemory.read({ scope: b })).advice.cloud, { 'cat:learn': 'cat:ai' });
  assert.deepEqual((await PlanMemory.read({ scope: 'other' })).names.map(item => item.n), ['My Name']);
  assert.deepEqual((await PlanMemory.read({ scope: 'other' })).advice.cloud, {});
});

test('scoped consolidation advice expires and has a global pair bound', async () => {
  const local = installStorage();
  await PlanMemory.putAdvice({ 'cat:learn': 'cat:ai' }, { scope: 'old-scope' });
  local[PlanMemory.STORAGE_KEY].advice.scopes['old-scope'].t = Date.now() - 15 * DAY_MS;
  assert.deepEqual((await PlanMemory.read({ scope: 'old-scope' })).advice.cloud, {});
  for (let index = 0; index < 15; index++) {
    await PlanMemory.putAdvice(Object.fromEntries(Array.from({ length: 30 }, (_, pair) => [`task:${pair}`, 'cat:dev'])), { scope: `scope-${index}` });
  }
  const memory = await PlanMemory.read();
  const scopes = Object.values(memory.advice.scopes || {});
  assert.ok(scopes.length <= 12);
  assert.ok(scopes.reduce((count, value) => count + Object.keys(value.cloud).length, Object.keys(memory.advice.cloud).length) <= 200);
});
