import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessGroupingQuality,
  clusterTabsWithAI,
  formatTabsPrompt,
  getAdaptiveGroupRange,
  getCompatibleRequestControls,
  getGeminiGenerationConfig,
  isCompatibleReasoningModel,
  isOpenAIReasoningModel
} from '../src/ai-engine.js';
import { ExactResultCache, LearningCache, fingerprintTab, sanitizeSemanticUrl } from '../src/cache-engine.js';
import { executeTabGrouping, getDuplicateTabKey, ungroupAllTabs } from '../src/grouper.js';
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
  assert.deepEqual(groups.find(group => group.name === 'Socials')?.tabIds, [3, 4, 5]);
  assert.deepEqual(groups.find(group => group.name === 'AI · Assistants')?.tabIds, [6, 7]);
  assert.deepEqual(groups.find(group => group.name === 'Acme')?.tabIds, [8, 9]);
  assert.equal(getSiteCategory('https://app.slack.com/client').name, 'Socials');
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
  assert.deepEqual(groups.find(group => group.name === 'Socials')?.tabIds, [7, 10]);
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

  assert.deepEqual(groups.map(group => group.name), ['Socials · X', 'Socials · Reddit', 'Socials · Slack']);
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

test('cloud prompt retains complete titles and compact local ordinals without URL fragments', () => {
  const longTitle = `Detailed task ${'context '.repeat(30)}— Site`;
  const prompt = formatTabsPrompt([
    { id: 98273465, title: longTitle, url: 'https://app.example.com/projects/1234567890123456/details?q=private+search', active: true },
    { id: 11223344, title: 'Second title', url: 'https://example.com/#/settings', active: false }
  ]);

  assert.match(prompt, /\[id, completeTitle, urlHint, active\]/);
  assert.ok(prompt.includes(longTitle));
  assert.ok(!prompt.includes('98273465'));
  assert.ok(!prompt.includes('private'));
  assert.ok(prompt.includes('app.example.com/projects/:id/details'));
  assert.ok(prompt.includes('example.com'));
  assert.ok(!prompt.includes('#/settings'));
  assert.equal(sanitizeSemanticUrl('https://example.com/#/settings'), 'example.com#/settings');
});

test('adaptive grouping expands for a crowded window and rejects broad catch-alls', () => {
  assert.deepEqual(getAdaptiveGroupRange(34), { min: 4, max: 8 });
  assert.deepEqual(getAdaptiveGroupRange(105), { min: 7, max: 12 });
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

test('crowded windows reject groups that consume more than one fifth of the strip', () => {
  const groups = [
    { name: 'Germany & France', tabIds: Array.from({ length: 24 }, (_, index) => index + 1) },
    ...Array.from({ length: 8 }, (_, groupIndex) => ({
      name: `Region ${groupIndex + 1}`,
      tabIds: Array.from({ length: groupIndex === 7 ? 11 : 10 }, (_, index) => 25 + groupIndex * 10 + index)
    }))
  ];
  const quality = assessGroupingQuality(groups, 105);
  assert.equal(quality.passed, false);
  assert.ok(quality.issues.some(issue => issue.includes('too broad at 24 tabs')));
});

test('regional quality rejects country outliers and accepts an inclusive label', () => {
  const tabs = [
    { id: 1, url: 'https://www.governo.it/' },
    { id: 2, url: 'https://www.ulisboa.pt/' },
    { id: 3, url: 'https://www.gov.pl/' },
    { id: 4, url: 'https://www.uw.edu.pl/' }
  ];

  const inaccurate = assessGroupingQuality([
    { name: 'Southern Europe', tabIds: [1, 2, 3, 4] }
  ], tabs);
  assert.equal(inaccurate.passed, false);
  assert.ok(inaccurate.issues.some(issue => issue.includes('Polish tabs outside its label')));

  const inclusive = assessGroupingQuality([
    { name: 'Southern Europe', tabIds: [1, 2] },
    { name: 'Central Europe', tabIds: [3, 4] }
  ], tabs);
  assert.equal(inclusive.passed, true);
});

test('regional quality rejects arbitrary country pairs but accepts coherent neighbours', () => {
  const mixed = assessGroupingQuality([
    { name: 'Poland & Denmark', tabIds: [1, 2] }
  ], [
    { id: 1, url: 'https://www.gov.pl/' },
    { id: 2, url: 'https://www.dr.dk/' }
  ]);
  assert.equal(mixed.passed, false);
  assert.ok(mixed.issues.some(issue => issue.includes('arbitrary cross-region country pair')));

  const neighbours = assessGroupingQuality([
    { name: 'Austria & Switzerland', tabIds: [1, 2] }
  ], [
    { id: 1, url: 'https://www.orf.at/' },
    { id: 2, url: 'https://www.srf.ch/' }
  ]);
  assert.equal(neighbours.passed, true);
});

test('orchestrator retries a geographically inaccurate model result', async () => {
  installChromeStorageMock();
  const tabs = [
    { id: 41, windowId: 14, index: 0, active: true, pinned: false, incognito: false, title: 'Italian Government', url: 'https://www.governo.it/' },
    { id: 42, windowId: 14, index: 1, active: false, pinned: false, incognito: false, title: 'University of Lisbon', url: 'https://www.ulisboa.pt/' },
    { id: 43, windowId: 14, index: 2, active: false, pinned: false, incognito: false, title: 'Polish Government', url: 'https://www.gov.pl/' },
    { id: 44, windowId: 14, index: 3, active: false, pinned: false, incognito: false, title: 'University of Warsaw', url: 'https://www.uw.edu.pl/' }
  ];
  let groupId = 800;
  chrome.tabs = {
    async query() { return tabs.map(tab => ({ ...tab })); },
    async get(id) { return { ...tabs.find(tab => tab.id === id) }; },
    async remove() {},
    async group() { return groupId++; },
    async ungroup() {}
  };
  chrome.tabGroups = { async update() {} };

  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount++;
    const groups = fetchCount === 1
      ? [{ name: 'Southern Europe', color: 'orange', tabIds: [0, 1, 2, 3] }]
      : [
          { name: 'Southern Europe', color: 'orange', tabIds: [0, 1] },
          { name: 'Central Europe', color: 'blue', tabIds: [2, 3] }
        ];
    return {
      ok: true,
      async json() {
        return {
          model: 'qwen/qwen3.8-27b',
          choices: [{ message: { content: JSON.stringify({ groups }) } }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
        };
      }
    };
  };

  try {
    const result = await executeTabGrouping(14, {
      provider: 'groq',
      groqApiKey: 'test-only',
      groqModel: 'qwen/qwen3.8-27b'
    });

    assert.equal(fetchCount, 2);
    assert.deepEqual(result.groups.map(group => group.name), ['Southern Europe', 'Central Europe']);
    assert.deepEqual(result.qualityFlags, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('title-aware grouping moves X and Reddit out of an AI-created admin group', async () => {
  installChromeStorageMock();
  const tabs = [
    { id: 1, windowId: 9, index: 0, active: true, pinned: false, incognito: false, title: 'Home / X', url: 'https://x.com/home' },
    { id: 2, windowId: 9, index: 1, active: false, pinned: false, incognito: false, title: '/r/Chrome', url: 'https://www.reddit.com/r/chrome/' },
    { id: 3, windowId: 9, index: 2, active: false, pinned: false, incognito: false, title: 'Dashboard | Pathfinder', url: 'https://unifi.ui.com/consoles/pathfinder/protect/dashboard' },
    { id: 4, windowId: 9, index: 3, active: false, pinned: false, incognito: false, title: 'Billing', url: 'https://secure.backblaze.com/billing_card.htm' }
  ];
  let groupId = 600;
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
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        model: 'qwen/qwen3.8-27b',
        choices: [{ message: { content: JSON.stringify({ groups: [
          { name: 'System & Admin', color: 'grey', tabIds: [0, 1, 2, 3] }
        ] }) } }],
        usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 }
      };
    }
  });

  try {
    const result = await executeTabGrouping(9, {
      provider: 'groq',
      groqApiKey: 'test-only',
      groqModel: 'qwen/qwen3.8-27b'
    });

    assert.deepEqual(result.groups.map(group => ({ name: group.name, tabIds: group.tabIds })), [
      { name: 'Socials', tabIds: [1, 2] },
      { name: 'System & Admin', tabIds: [3, 4] }
    ]);
    assert.deepEqual(groupUpdates.map(group => group.title), ['Socials', 'System & Admin']);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test('OpenAI reasoning models omit temperature and request low reasoning effort', async () => {
  assert.equal(isOpenAIReasoningModel('gpt-5.4-nano'), true);
  assert.equal(isOpenAIReasoningModel('gpt-4o-mini'), false);
  assert.deepEqual(
    getCompatibleRequestControls('openai', 'gpt-5.4-nano'),
    { reasoning_effort: 'low' }
  );
  assert.deepEqual(
    getCompatibleRequestControls('openai', 'gpt-4o-mini'),
    { temperature: 0 }
  );

  const originalFetch = globalThis.fetch;
  let requestPayload;
  globalThis.fetch = async (_url, options) => {
    requestPayload = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return {
          model: 'gpt-5.4-nano',
          choices: [{ message: { content: JSON.stringify({
            groups: [{ name: 'Build', color: 'blue', tabIds: [0, 1] }]
          }) } }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
        };
      }
    };
  };

  try {
    await clusterTabsWithAI([
      { id: 710001, title: 'Issue implementation', url: 'https://github.com/org/repo/issues/1' },
      { id: 710002, title: 'API reference', url: 'https://docs.example.com/api' }
    ], {
      provider: 'openai',
      openaiApiKey: 'test-only',
      openaiModel: 'gpt-5.4-nano'
    });

    assert.equal('temperature' in requestPayload, false);
    assert.equal(requestPayload.reasoning_effort, 'low');
    assert.equal(requestPayload.messages[0].role, 'developer');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('provider request controls use each reasoning API without leaking unsupported fields', () => {
  const cases = [
    ['xai', 'grok-4.6', { reasoning_effort: 'low' }],
    ['groq', 'qwen/qwen3.8-27b', {
      temperature: 0,
      reasoning_effort: 'low',
      include_reasoning: false
    }],
    ['openrouter', 'google/gemini-2.5-flash-lite', {
      reasoning: { effort: 'low', exclude: true }
    }],
    ['deepseek', 'deepseek-flash', {
      reasoning_effort: 'low',
      thinking: { type: 'enabled' }
    }],
    ['cerebras', 'gpt-oss-120b', {
      temperature: 0,
      reasoning_effort: 'low',
      reasoning_format: 'hidden'
    }],
    ['ollama', 'qwen3:8b', { temperature: 0, reasoning_effort: 'low' }]
  ];

  for (const [provider, model, expected] of cases) {
    assert.equal(isCompatibleReasoningModel(provider, model), true, `${provider}:${model}`);
    assert.deepEqual(getCompatibleRequestControls(provider, model), expected);
  }

  assert.equal(isCompatibleReasoningModel('cerebras', 'qwen-3.8-27b'), false);
  assert.deepEqual(getCompatibleRequestControls('cerebras', 'qwen-3.8-27b'), { temperature: 0 });
  assert.equal(isCompatibleReasoningModel('ollama', 'qwen2.5-coder:32b'), false);
  assert.deepEqual(getCompatibleRequestControls('ollama', 'qwen2.5-coder:32b'), { temperature: 0 });
});

test('Gemini thinking controls are version-aware', () => {
  assert.deepEqual(
    getGeminiGenerationConfig('gemini-2.5-flash-lite', {
      responseMimeType: 'application/json',
      temperature: 0.2
    }),
    {
      responseMimeType: 'application/json',
      temperature: 0.2,
      thinkingConfig: { thinkingBudget: 512 }
    }
  );
  assert.deepEqual(
    getGeminiGenerationConfig('gemini-3.5-flash', {
      responseMimeType: 'application/json',
      temperature: 0.2
    }),
    {
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingLevel: 'LOW' }
    }
  );
  assert.deepEqual(
    getGeminiGenerationConfig('gemini-2.0-flash', { temperature: 0.2 }),
    { temperature: 0.2 }
  );
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

test('exact result cache misses when a long URL path changes', async () => {
  const { local } = installChromeStorageMock();
  const sharedPath = 'a'.repeat(90);
  const originalTabs = [
    { id: 10, title: 'Account', url: `https://example.com/${sharedPath}one` },
    { id: 11, title: 'Reference', url: 'https://docs.example.com/reference' }
  ];
  const scope = 'semantic-v2:offline';
  const context = await ExactResultCache.makeContext(originalTabs, scope);
  await ExactResultCache.put(context, [
    { name: 'Account', color: 'blue', tabIds: [10] },
    { name: 'Reference', color: 'green', tabIds: [11] }
  ]);

  const changed = await ExactResultCache.get([
    { id: 20, title: 'Account', url: `https://example.com/${sharedPath}two` },
    { id: 21, title: 'Reference', url: 'https://docs.example.com/reference' }
  ], scope);

  assert.equal(changed.groups, null);
  assert.ok(!JSON.stringify(local.foldnex_exact_results_v1).includes(originalTabs[0].url));
});

test('exact cache fingerprint excludes sensitive query values and fragments', async () => {
  const tab = { title: 'Account', url: 'https://example.com/account?access_token=first#session=first' };
  const original = await fingerprintTab(tab);
  const changedSecret = await fingerprintTab({
    ...tab,
    url: 'https://example.com/account?access_token=second#session=second'
  });
  const changedPath = await fingerprintTab({ ...tab, url: 'https://example.com/other?access_token=first' });

  assert.equal(changedSecret, original);
  assert.notEqual(changedPath, original);
});

test('ungroup includes tabs in valid group ID zero', async () => {
  installChromeStorageMock();
  let ungroupedIds = null;
  chrome.tabs = {
    async query() {
      return [
        { id: 1, groupId: 0 },
        { id: 2, groupId: -1 }
      ];
    },
    async ungroup(ids) { ungroupedIds = ids; }
  };
  chrome.tabGroups = { TAB_GROUP_ID_NONE: -1 };

  const result = await ungroupAllTabs(5);

  assert.deepEqual(ungroupedIds, [1]);
  assert.equal(result.ungroupedCount, 1);
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

test('unavailable Nano falls back offline without sending saved cloud credentials', async () => {
  installChromeStorageMock();
  const tabs = [
    { id: 801, windowId: 11, index: 0, active: true, pinned: false, incognito: false, title: 'Project board', url: 'https://github.com/org/repo/projects' },
    { id: 802, windowId: 11, index: 1, active: false, pinned: false, incognito: false, title: 'Pull request', url: 'https://github.com/org/repo/pulls' }
  ];
  let groupId = 810;
  chrome.tabs = {
    async query() { return tabs.map(tab => ({ ...tab })); },
    async get(id) { return { ...tabs.find(tab => tab.id === id) }; },
    async remove() {},
    async group() { return groupId++; },
    async ungroup() {}
  };
  chrome.tabGroups = { async update() {} };

  const originalFetch = globalThis.fetch;
  const hadSelf = Object.hasOwn(globalThis, 'self');
  const originalSelf = globalThis.self;
  const hadLanguageModel = Object.hasOwn(globalThis, 'LanguageModel');
  const originalLanguageModel = globalThis.LanguageModel;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount++;
    throw new Error('Nano selection must not call a cloud provider');
  };
  try {
    globalThis.self = globalThis;
    delete globalThis.LanguageModel;
    const unavailableResult = await executeTabGrouping(11, {
      provider: 'gemini_nano',
      geminiApiKey: 'saved-gemini-key',
      openaiApiKey: 'saved-openai-key'
    });

    assert.equal(unavailableResult.source, 'offline-fallback');
    assert.equal(unavailableResult.fallbackUsed, true);

    globalThis.LanguageModel = {
      async availability() { return 'readily'; },
      async create() { throw new Error('Local model session failed'); }
    };
    const failedRuntimeResult = await executeTabGrouping(11, {
      provider: 'gemini_nano',
      geminiApiKey: 'saved-gemini-key',
      openaiApiKey: 'saved-openai-key'
    });

    assert.equal(failedRuntimeResult.source, 'offline-fallback');
    assert.equal(failedRuntimeResult.fallbackUsed, true);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (hadSelf) globalThis.self = originalSelf;
    else delete globalThis.self;
    if (hadLanguageModel) globalThis.LanguageModel = originalLanguageModel;
    else delete globalThis.LanguageModel;
  }
});

test('provider error details are not persisted in run diagnostics', async () => {
  const { local } = installChromeStorageMock();
  const tabs = [
    { id: 901, windowId: 13, index: 0, active: true, pinned: false, incognito: false, title: 'Confidential project', url: 'https://example.com/private' },
    { id: 902, windowId: 13, index: 1, active: false, pinned: false, incognito: false, title: 'Project notes', url: 'https://example.com/notes' }
  ];
  chrome.tabs = {
    async query() { return tabs.map(tab => ({ ...tab })); },
    async get(id) { return { ...tabs.find(tab => tab.id === id) }; },
    async remove() {},
    async group() { return 900; },
    async ungroup() {}
  };
  chrome.tabGroups = { async update() {} };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    async json() { return { error: { message: 'Rejected Confidential project at https://example.com/private' } }; }
  });

  try {
    const result = await executeTabGrouping(13, { provider: 'groq', groqApiKey: 'test-only' });
    assert.equal(result.source, 'offline-fallback');
    assert.equal(result.fallbackReason, 'Provider request failed');
    assert.equal(local.foldnex_last_run.fallbackCode, 'provider_error');
    assert.ok(!JSON.stringify(local.foldnex_last_run).includes('Confidential project'));
    assert.ok(!JSON.stringify(local.foldnex_last_run).includes('https://example.com/private'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('incognito site grouping leaves persistent extension storage untouched', async () => {
  const { local } = installChromeStorageMock();
  const tabs = [
    { id: 901, windowId: 12, index: 0, active: true, pinned: false, incognito: true, title: 'Home / X', url: 'https://x.com/home' },
    { id: 902, windowId: 12, index: 1, active: false, pinned: false, incognito: true, title: '/r/Chrome', url: 'https://reddit.com/r/chrome/' },
    { id: 903, windowId: 12, index: 2, active: false, pinned: false, incognito: true, title: 'Messages', url: 'https://app.slack.com/client/team/channel' }
  ];
  let groupId = 900;
  chrome.tabs = {
    async query() { return tabs.map(tab => ({ ...tab })); },
    async get(id) { return { ...tabs.find(tab => tab.id === id) }; },
    async remove() {},
    async group() { return groupId++; },
    async ungroup() {}
  };
  chrome.tabGroups = { async update() {} };

  const result = await executeTabGrouping(12, {
    groupingStrategy: 'site',
    provider: 'offline'
  });

  assert.equal(result.source, 'site-category');
  assert.deepEqual(result.groups.map(group => group.name), ['Socials']);
  assert.deepEqual(local, {});
});
