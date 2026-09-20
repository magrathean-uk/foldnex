import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessGroupingQuality,
  clusterTabsWithAI,
  formatTabsPrompt,
  getAdaptiveGroupRange
} from '../src/ai-engine.js';
import { ExactResultCache, LearningCache } from '../src/cache-engine.js';
import { executeTabGrouping, getDuplicateTabKey } from '../src/grouper.js';
import {
  consumeProgrammaticGroupUpdate,
  getGroupTitleBaseline,
  markProgrammaticGroupUpdate,
  setGroupTitleBaseline
} from '../src/group-state.js';

function installChromeStorageMock() {
  const local = {};
  const session = {};
  const makeArea = store => ({
    async get(keys) {
      if (keys === undefined || keys === null) return { ...store };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter(key => key in store).map(key => [key, store[key]]));
    },
    async set(values) {
      Object.assign(store, values);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    }
  });
  globalThis.chrome = {
    storage: {
      local: makeArea(local),
      session: makeArea(session)
    }
  };
  return { local, session };
}

test('duplicate identity preserves routes and schemes but removes document anchors', () => {
  assert.equal(
    getDuplicateTabKey({ url: 'https://example.com/page#section-two' }),
    'https://example.com/page'
  );
  assert.equal(
    getDuplicateTabKey({ url: 'https://example.com/#/settings' }),
    'https://example.com/#/settings'
  );
  assert.notEqual(
    getDuplicateTabKey({ url: 'http://example.com/page' }),
    getDuplicateTabKey({ url: 'https://example.com/page' })
  );
  assert.equal(getDuplicateTabKey({ url: 'chrome://extensions/' }), 'chrome://extensions/');
  assert.equal(getDuplicateTabKey({ url: 'chrome-extension://abc/options.html' }), null);
});

test('prompt retains complete titles and uses compact local ordinals', () => {
  const longTitle = `Detailed task ${'context '.repeat(30)}— Site`;
  const prompt = formatTabsPrompt([
    { id: 98273465, title: longTitle, url: 'https://app.example.com/projects/1234567890123456/details', active: true },
    { id: 11223344, title: 'Second title', url: 'https://example.com/#/settings', active: false }
  ]);

  assert.match(prompt, /\[id, completeTitle, urlHint, active\]/);
  assert.ok(prompt.includes(longTitle));
  assert.ok(!prompt.includes('98273465'));
  assert.ok(prompt.includes('app.example.com/projects/:id/details'));
  assert.ok(prompt.includes('example.com#/settings'));
});

test('adaptive grouping expands for a crowded window and rejects broad catch-alls', () => {
  assert.deepEqual(getAdaptiveGroupRange(34), { min: 4, max: 8 });
  const quality = assessGroupingQuality([
    { name: 'General', tabIds: [1, 2, 3, 4, 5, 6, 7] },
    { name: 'Video', tabIds: [8, 9, 10, 11, 12, 13, 14, 15] },
    { name: 'Assets', tabIds: Array.from({ length: 14 }, (_, index) => index + 16) },
    { name: 'Design', tabIds: [30, 31, 32, 33, 34] }
  ], 34);
  assert.equal(quality.passed, false);
  assert.ok(quality.issues.some(issue => issue.includes('vague group')));
  assert.ok(quality.issues.some(issue => issue.includes('too broad')));
});

test('Groq request uses compact JSON output and maps ordinals back to Chrome IDs', async () => {
  const originalFetch = globalThis.fetch;
  let requestPayload;
  globalThis.fetch = async (_url, options) => {
    requestPayload = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return {
          model: 'openai/gpt-oss-20b',
          choices: [{ message: { content: JSON.stringify({
            groups: [{ name: 'Build', color: 'blue', tabIds: [0, 1] }]
          }) } }],
          usage: {
            prompt_tokens: 140,
            completion_tokens: 24,
            total_tokens: 164,
            prompt_tokens_details: { cached_tokens: 64 }
          }
        };
      }
    };
  };

  try {
    const result = await clusterTabsWithAI([
      { id: 700001, title: 'Issue implementation', url: 'https://github.com/org/repo/issues/1' },
      { id: 700002, title: 'API reference', url: 'https://docs.example.com/api' }
    ], {
      provider: 'groq',
      groqApiKey: 'test-only',
      groqModel: 'openai/gpt-oss-20b'
    });

    assert.deepEqual(result.groups[0].tabIds, [700001, 700002]);
    assert.equal(result.meta.usage.cachedTokens, 64);
    assert.equal(requestPayload.response_format.type, 'json_object');
    assert.equal(requestPayload.reasoning_effort, 'low');
    assert.ok(requestPayload.max_completion_tokens <= 1536);
    assert.ok(!optionsContainChromeIds(requestPayload, [700001, 700002]));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function optionsContainChromeIds(payload, ids) {
  const body = JSON.stringify(payload);
  return ids.some(id => body.includes(String(id)));
}

test('exact result cache only reuses an identical semantic window', async () => {
  installChromeStorageMock();
  const tabs = [
    { id: 10, title: 'Video edit', url: 'https://example.com/video' },
    { id: 11, title: 'Motion template', url: 'https://example.com/template' }
  ];
  const context = await ExactResultCache.makeContext(tabs, 'semantic-v2:groq:20b');
  await ExactResultCache.put(context, [{ name: 'Video', color: 'green', tabIds: [10, 11] }]);

  const hit = await ExactResultCache.get([
    { ...tabs[0], id: 20 },
    { ...tabs[1], id: 21 }
  ], 'semantic-v2:groq:20b');
  assert.deepEqual(hit.groups, [{ name: 'Video', color: 'green', tabIds: [20, 21] }]);

  const miss = await ExactResultCache.get([
    { ...tabs[0], id: 20, title: 'Different task' },
    { ...tabs[1], id: 21 }
  ], 'semantic-v2:groq:20b');
  assert.equal(miss.groups, null);
});

test('schema migration quarantines legacy rules and starts v2 cleanly', async () => {
  const { local } = installChromeStorageMock();
  local.foldnex_learned_rules = [{ pattern: 'slack.com/client/*', category: 'General', userOverride: true }];
  await LearningCache.ensureSchema();
  assert.deepEqual(await LearningCache.getRules(), []);
  assert.equal(local.foldnex_learning_schema_version, 2);
  assert.equal(local.foldnex_legacy_rules_backup.rules.length, 1);
});

test('shared session ledger suppresses a programmatic title exactly once', async () => {
  installChromeStorageMock();
  await markProgrammaticGroupUpdate(42, 'Video Production');
  assert.equal(await getGroupTitleBaseline(42), 'Video Production');
  assert.equal(await consumeProgrammaticGroupUpdate({ id: 42, title: 'Video Production' }), true);
  assert.equal(await consumeProgrammaticGroupUpdate({ id: 42, title: 'Video Production' }), false);

  await setGroupTitleBaseline(42, 'Edited by user');
  assert.equal(await getGroupTitleBaseline(42), 'Edited by user');
});

test('programmatic ledgers for adjacent groups do not overwrite each other', async () => {
  installChromeStorageMock();
  await markProgrammaticGroupUpdate(1, 'First');
  await markProgrammaticGroupUpdate(2, 'Second');
  assert.equal(await consumeProgrammaticGroupUpdate({ id: 1, title: 'First' }), true);
  assert.equal(await consumeProgrammaticGroupUpdate({ id: 2, title: 'Second' }), true);
});

test('orchestrator calls AI once, records diagnostics, then reuses an identical window', async () => {
  const { local } = installChromeStorageMock();
  const tabs = Array.from({ length: 8 }, (_, index) => ({
    id: 100 + index,
    windowId: 5,
    index,
    active: index === 0,
    pinned: false,
    incognito: false,
    title: index < 4 ? `Video task ${index}` : `Design task ${index}`,
    url: `https://example.com/${index < 4 ? 'video' : 'design'}/${index}`
  }));
  let groupId = 200;
  let fetchCount = 0;
  const groupUpdates = [];
  chrome.tabs = {
    async query() { return tabs.map(tab => ({ ...tab })); },
    async get(id) { return { ...tabs.find(tab => tab.id === id) }; },
    async remove() {},
    async group() { return groupId++; },
    async ungroup() {}
  };
  chrome.tabGroups = {
    async update(id, details) { groupUpdates.push({ id, ...details }); }
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCount++;
    return {
      ok: true,
      async json() {
        return {
          model: 'openai/gpt-oss-20b',
          choices: [{ message: { content: JSON.stringify({ groups: [
            { name: 'Video Production', color: 'green', tabIds: [0, 1, 2, 3] },
            { name: 'Design References', color: 'purple', tabIds: [4, 5, 6, 7] }
          ] }) } }],
          usage: { prompt_tokens: 220, completion_tokens: 48, total_tokens: 268 }
        };
      }
    };
  };

  const settings = {
    provider: 'groq',
    groqApiKey: 'test-only',
    groqModel: 'openai/gpt-oss-20b',
    collapseGroupsOnCreation: false
  };

  try {
    const first = await executeTabGrouping(5, settings);
    assert.equal(first.source, 'cloud');
    assert.equal(first.groupsCreated, 2);
    assert.equal(fetchCount, 1);
    assert.equal(local.foldnex_last_run.promptTokens, 220);
    assert.equal((await LearningCache.getRules()).length, 0);

    const second = await executeTabGrouping(5, settings);
    assert.equal(second.source, 'exact-cache');
    assert.equal(second.groupsCreated, 2);
    assert.equal(fetchCount, 1);
    assert.equal(groupUpdates.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
