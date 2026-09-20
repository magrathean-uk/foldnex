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
import { clusterTabsBySite, getSiteCategory } from '../src/site-clusterer.js';
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

test('site-category grouping keeps brands together and uses the requested taxonomy', () => {
  const groups = clusterTabsBySite([
    { id: 1, url: 'https://elements.envato.com/3d' },
    { id: 2, url: 'https://account.envato.com/subscriptions' },
    { id: 3, url: 'https://x.com/home' },
    { id: 4, url: 'https://www.reddit.com/r/chrome/' },
    { id: 5, url: 'https://app.slack.com/client/workspace/channel' },
    { id: 6, url: 'https://chatgpt.com/c/123' },
    { id: 7, url: 'https://grok.com/' },
    { id: 8, url: 'https://docs.acme.co.uk/start' },
    { id: 9, url: 'https://app.acme.co.uk/dashboard' }
  ]);

  assert.deepEqual(groups.find(group => group.name === 'Envato')?.tabIds, [1, 2]);
  assert.deepEqual(groups.find(group => group.name === 'Social')?.tabIds, [3, 4, 5]);
  assert.deepEqual(groups.find(group => group.name === 'AI · Assistants')?.tabIds, [6, 7]);
  assert.deepEqual(groups.find(group => group.name === 'Acme')?.tabIds, [8, 9]);
  assert.equal(getSiteCategory('https://app.slack.com/client').name, 'Social');
});

test('address taxonomy separates AI, code, email, social, and dedicated heavy services', () => {
  const groups = clusterTabsBySite([
    { id: 1, url: 'https://chatgpt.com/c/one' },
    { id: 2, url: 'https://grok.com/' },
    { id: 3, url: 'https://platform.openai.com/docs' },
    { id: 4, url: 'https://console.groq.com/docs' },
    { id: 5, url: 'https://github.com/example/repo' },
    { id: 6, url: 'https://outlook.live.com/mail/' },
    { id: 7, url: 'https://x.com/home' },
    { id: 8, url: 'https://studio.youtube.com/channel/example' },
    { id: 9, url: 'https://www.linkedin.com/jobs/search/' },
    { id: 10, url: 'https://www.linkedin.com/feed/' }
  ]);

  assert.deepEqual(groups.find(group => group.name === 'AI · Assistants')?.tabIds, [1, 2]);
  assert.deepEqual(groups.find(group => group.name === 'AI · Platforms')?.tabIds, [3, 4]);
  assert.deepEqual(groups.find(group => group.name === 'Code & Repositories')?.tabIds, [5]);
  assert.deepEqual(groups.find(group => group.name === 'Email')?.tabIds, [6]);
  assert.deepEqual(groups.find(group => group.name === 'Social')?.tabIds, [7, 10]);
  assert.deepEqual(groups.find(group => group.name === 'YouTube')?.tabIds, [8]);
  assert.deepEqual(groups.find(group => group.name === 'Careers')?.tabIds, [9]);
});

test('oversized multi-service categories split at site boundaries', () => {
  const tabs = [
    ...Array.from({ length: 7 }, (_, index) => ({ id: index + 1, url: `https://x.com/post/${index}` })),
    ...Array.from({ length: 5 }, (_, index) => ({ id: index + 8, url: `https://reddit.com/r/test/${index}` })),
    ...Array.from({ length: 5 }, (_, index) => ({ id: index + 13, url: `https://app.slack.com/client/team/${index}` }))
  ];
  const groups = clusterTabsBySite(tabs);

  assert.deepEqual(groups.map(group => group.name), ['Social · X', 'Social · Reddit', 'Social · Slack']);
  assert.deepEqual(groups.map(group => group.tabIds.length), [7, 5, 5]);
});

test('dedicated services remain whole and one-off unknowns use bounded review groups', () => {
  const youtube = Array.from({ length: 24 }, (_, index) => ({
    id: index + 1,
    url: `https://${index % 2 ? 'studio' : 'www'}.youtube.com/watch?v=${index}`
  }));
  const unknown = Array.from({ length: 17 }, (_, index) => ({
    id: index + 100,
    url: `https://one-off-${index}.example-${index}.com/page`
  }));
  const groups = clusterTabsBySite([...youtube, ...unknown]);

  assert.equal(groups.find(group => group.name === 'YouTube')?.tabIds.length, 24);
  assert.deepEqual(
    groups.filter(group => group.name.startsWith('Review Later')).map(group => group.tabIds.length),
    [8, 8, 1]
  );
});

test('a 200-tab address window stays deterministic, complete, and below 30 groups', () => {
  const families = [
    'x.com', 'reddit.com', 'app.slack.com', 'chatgpt.com', 'grok.com',
    'platform.openai.com', 'console.groq.com', 'youtube.com', 'elements.envato.com',
    'github.com', 'localhost', 'dash.cloudflare.com', 'unifi.ui.com',
    'appstoreconnect.apple.com', 'analytics.google.com', 'google.com',
    'bbc.co.uk', 'uk.indeed.com', 'sportsdirect.com', 'amazon.co.uk',
    'booking.com', 'zoopla.co.uk', 'paypal.com', 'luma.com', 'support.apple.com'
  ];
  const tabs = Array.from({ length: 200 }, (_, index) => {
    const host = families[index % families.length];
    const path = host === 'google.com' ? `/search?q=${index}` : `/page/${index}`;
    return { id: index + 1, url: `https://${host}${path}` };
  });
  const first = clusterTabsBySite(tabs);
  const second = clusterTabsBySite(tabs);
  const assigned = first.flatMap(group => group.tabIds);

  assert.deepEqual(first, second);
  assert.equal(new Set(assigned).size, tabs.length);
  assert.equal(assigned.length, tabs.length);
  assert.ok(first.length >= 15);
  assert.ok(first.length <= 30);
  assert.ok(!first.some(group => /tech/i.test(group.name)));
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

test('site-category strategy bypasses AI and accepts a large same-site group', async () => {
  const { local } = installChromeStorageMock();
  const tabs = Array.from({ length: 10 }, (_, index) => ({
    id: 300 + index,
    windowId: 8,
    index,
    active: index === 0,
    pinned: false,
    incognito: false,
    title: `Different Envato task ${index}`,
    url: `https://${index % 2 ? 'account' : 'elements'}.envato.com/item/${index}`
  }));
  let groupId = 500;
  chrome.tabs = {
    async query() { return tabs.map(tab => ({ ...tab })); },
    async get(id) { return { ...tabs.find(tab => tab.id === id) }; },
    async remove() {},
    async group() { return groupId++; },
    async ungroup() {}
  };
  chrome.tabGroups = { async update() {} };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('site grouping must not call a provider'); };
  try {
    const result = await executeTabGrouping(8, {
      groupingStrategy: 'site',
      provider: 'groq',
      groqApiKey: 'test-only'
    });
    assert.equal(result.source, 'site-category');
    assert.equal(result.model, null);
    assert.equal(result.groupsCreated, 1);
    assert.deepEqual(result.groups[0].tabIds, tabs.map(tab => tab.id));
    assert.deepEqual(result.qualityFlags, []);
    assert.equal(local.foldnex_last_run.strategy, 'site');
    assert.equal(local.foldnex_last_run.promptTokens, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
