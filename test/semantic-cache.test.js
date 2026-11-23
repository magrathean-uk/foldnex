import assert from 'node:assert/strict';
import test from 'node:test';

import { assessGroupingQuality, groupCeiling, labelCacheScope, MAX_GROUPS } from '../src/ai-engine.js';
import { ExactResultCache, PlanMemory, WindowPlanStore, hashToken } from '../src/cache-engine.js';

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

test('semantic scope changes with engine, model, effective effort and Ollama endpoint, never credentials or priority', () => {
  const original = labelCacheScope(openai);
  assert.equal(original, labelCacheScope({ ...openai, openaiApiKey: 'one-test-secret', openaiOAuthToken: 'another-test-secret', openaiPriority: false }));
  assert.equal(original, labelCacheScope({ ...openai, openaiBaseUrl: 'https://api.openai.com/v1/' }));
  assert.equal(original, labelCacheScope({ ...openai, openaiBaseUrl: 'https://user:password@api.openai.com/v1?token=secret#fragment' }));
  // A fixed provider ignores a saved endpoint (D40); Ollama's endpoint still separates scopes.
  assert.equal(original, labelCacheScope({ ...openai, openaiBaseUrl: 'https://alternative.test/v1' }));
  assert.notEqual(labelCacheScope({ provider: 'ollama' }), labelCacheScope({ provider: 'ollama', ollamaBaseUrl: 'https://ollama.example/v1' }));
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

test('stored model names follow their scope while user renames remain global', async () => {
  const local = installStorage();
  const a = labelCacheScope(openai);
  const b = labelCacheScope({ provider: 'gemini_api' });
  const now = Date.now();
  const record = { k: ['cat:ai'], w: [hashToken('topic')], n: 'Legacy Name', s: 'cloud', t: now };
  // Model names were written by the retired naming requests; they stay readable.
  local[PlanMemory.STORAGE_KEY] = {
    v: 1,
    names: [record, { ...record, n: 'OpenAI Name', p: a }, { ...record, n: 'Gemini Name', s: 'nano', p: b }],
    advice: { cloud: {}, t: 0 }
  };
  await PlanMemory.recordUserRename({ tabs: [tab], name: 'My Name', keys: ['cat:ai'], color: 'blue' });
  assert.deepEqual((await PlanMemory.read({ scope: a })).names.map(item => item.n).sort(), ['My Name', 'OpenAI Name']);
  assert.deepEqual((await PlanMemory.read({ scope: b })).names.map(item => item.n).sort(), ['Gemini Name', 'My Name']);
  assert.deepEqual((await PlanMemory.read({ scope: 'other' })).names.map(item => item.n), ['My Name']);
  assert.deepEqual((await PlanMemory.read()).names.map(item => item.n).sort(), ['Gemini Name', 'Legacy Name', 'My Name', 'OpenAI Name']);
});
