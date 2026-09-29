import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  assessGroupingQuality,
  buildLabelPrompt,
  formatLabelRows,
  getAdaptiveGroupRange,
  groupCeiling,
  labelTabsWithAI,
  NAME_SYSTEM,
  PROMPT_TITLE_LIMIT,
  PROVIDER_CATALOG,
  getCompatibleRequestControls,
  getEffectiveReasoningEffort,
  getGeminiGenerationConfig,
  getReasoningEffortOptions,
  isCompatibleReasoningModel,
  isOpenAIReasoningModel,
  isOpenAIResponsesOnlyModel,
  resetNanoBases
} from '../src/ai-engine.js';
import {
  ExactResultCache,
  LearningCache,
  PlanMemory,
  TabLabelCache,
  WindowPlanStore,
  fingerprintTab,
  sanitizeSemanticUrl
} from '../src/cache-engine.js';
import {
  createClickBudget,
  executeTabGrouping,
  getDuplicateTabKey,
  PREPARED_NAMING_WAIT_MS,
  ungroupAllTabs
} from '../src/grouper.js';
import {
  autoGroupWindow,
  classifyTabs,
  createBackgroundClassifier,
  refreshAndAutoGroup,
  refreshWindowPlan
} from '../src/background-classifier.js';
import { CATEGORY_KEYS } from '../src/label-vocabulary.js';
import { planGroups } from '../src/planner.js';
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

/** Deterministic category per title, standing in for a model. */
function keyForTitle(title) {
  const text = String(title).toLowerCase();
  if (/recipe|ramen|kitchen/.test(text)) return 'food';
  if (/flight|hotel|trip/.test(text)) return 'travel';
  if (/react|rust|issue|pull request/.test(text)) return 'dev';
  if (/video/.test(text)) return 'video';
  if (/design/.test(text)) return 'design';
  if (/game/.test(text)) return 'games';
  if (/government/.test(text)) return 'admin';
  if (/university/.test(text)) return 'learn';
  if (/billing/.test(text)) return 'money';
  if (/dashboard/.test(text)) return 'infra';
  return 'learn';
}

const TOPIC_TITLES = {
  food: 'Easy ramen recipe',
  travel: 'Cheap flights to Tokyo',
  dev: 'React hooks reference',
  video: 'Video task',
  design: 'Design task',
  games: 'Strategy game guide'
};

/** Tabs per topic, each on its own site, in strip order. */
function makeTopicTabs(windowId, startId, counts, extra = {}) {
  const tabs = [];
  for (const [topic, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i++) {
      const index = tabs.length;
      tabs.push({
        id: startId + index,
        windowId,
        index,
        active: index === 0,
        pinned: false,
        incognito: false,
        status: 'complete',
        groupId: -1,
        title: `${TOPIC_TITLES[topic]} ${i}`,
        url: `https://www.${topic}-site-${i}.com/page/${i}`,
        ...extra
      });
    }
  }
  return tabs;
}

/**
 * A Chrome mock for one or more windows: storage (local, session, sync), tabs
 * filtered by windowId and groupId, and tab groups that remember membership.
 */
function installBrowser(tabs, { sync = {}, chromeGroups = [] } = {}) {
  const { local, session } = installChromeStorageMock();
  const calls = { group: [], update: [], labelStores: 0 };
  let nextGroupId = 3000;
  const localSet = chrome.storage.local.set;
  chrome.storage.local.set = async values => {
    if (TabLabelCache.STORAGE_KEY in values) calls.labelStores++;
    return localSet(values);
  };
  chrome.storage.sync = {
    async get(keys) {
      if (keys === undefined || keys === null) return { ...sync };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter(key => key in sync).map(key => [key, sync[key]]));
    },
    async set(values) { Object.assign(sync, values); }
  };
  chrome.tabs = {
    async query(query = {}) {
      return tabs
        .filter(tab => query.windowId === undefined || tab.windowId === query.windowId)
        .filter(tab => query.groupId === undefined || tab.groupId === query.groupId)
        .map(tab => ({ ...tab }));
    },
    async get(id) {
      const tab = tabs.find(item => item.id === id);
      if (!tab) throw new Error(`No tab with id: ${id}`);
      return { ...tab };
    },
    async remove() {},
    async group(details) {
      calls.group.push(JSON.parse(JSON.stringify(details)));
      const groupId = details.groupId ?? nextGroupId++;
      for (const id of details.tabIds) {
        const tab = tabs.find(item => item.id === id);
        if (tab) tab.groupId = groupId;
      }
      return groupId;
    },
    async ungroup() {}
  };
  chrome.tabGroups = {
    TAB_GROUP_ID_NONE: -1,
    async query(query = {}) {
      return chromeGroups.filter(group => query.windowId === undefined || group.windowId === query.windowId);
    },
    async update(id, details) {
      calls.update.push({ id, ...details });
    }
  };
  return { local, session, calls, sync };
}

/**
 * Chrome's Prompt API: label prompts answer every "id | title | site/path"
 * line with keyForTitle; name prompts answer every folder with nameFor(current
 * name). Records create options, prompts and aborts.
 */
function installNanoMock({
  labelFor = keyForTitle,
  nameFor = name => name,
  hangLabels = false,
  labelDelayMs = 0,
  create = null,
  availability = 'available'
} = {}) {
  const calls = { create: [], labelPrompts: [], namePrompts: [], aborts: 0 };
  const makeSession = createOptions => ({
    inputUsage: 300,
    async clone() {
      return makeSession(createOptions);
    },
    async prompt(text, options) {
      const naming = createOptions?.initialPrompts?.[0]?.content === NAME_SYSTEM;
      (naming ? calls.namePrompts : calls.labelPrompts).push({ text, options });
      if (!naming && hangLabels) {
        await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            calls.aborts++;
            reject(options.signal.reason);
          }, { once: true });
        });
      }
      if (!naming && labelDelayMs > 0) await new Promise(resolve => setTimeout(resolve, labelDelayMs));
      const answer = {};
      for (const line of text.split('\n')) {
        const match = line.match(/^(\d+) \| (.*) \| (.*)$/);
        if (match) answer[match[1]] = naming ? nameFor(match[2]) : labelFor(match[2]);
      }
      return JSON.stringify(answer);
    },
    async measureInputUsage(text) {
      return Math.ceil(text.length / 4);
    },
    destroy() {}
  });
  resetNanoBases();
  globalThis.self = globalThis;
  globalThis.LanguageModel = {
    async availability() { return availability; },
    async create(options) {
      calls.create.push(options);
      return create ? create(options, makeSession) : makeSession(options);
    }
  };
  return calls;
}

function removeNanoMock() {
  resetNanoBases();
  delete globalThis.LanguageModel;
  delete globalThis.self;
}

const DEFAULT_FOLDER_NAMES = {
  food: 'Home Cooking', travel: 'Japan Trip', dev: 'React App', video: 'Video Production', design: 'Design References'
};

/**
 * OpenAI-compatible provider: label requests get keyForTitle per row,
 * consolidation requests get one folder per row named by folderName(row).
 */
function installCloudFetch({
  labelFor = keyForTitle,
  folderName = row => DEFAULT_FOLDER_NAMES[row[1]] || 'Mixed Picks',
  folders = null,
  delayMs = () => 0,
  usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
} = {}) {
  const original = globalThis.fetch;
  const requests = [];
  let completed = 0;
  globalThis.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    const content = payload.messages.at(-1).content;
    const request = { url, payload, kind: 'other', rows: [], signal: options.signal };
    if (content.includes('{"tabs":')) {
      request.kind = 'label';
      request.rows = JSON.parse(content.slice(content.lastIndexOf('{"tabs":'))).tabs;
    } else if (content.includes('{"rows":')) {
      request.kind = 'consolidate';
      request.rows = JSON.parse(content.slice(content.lastIndexOf('{"rows":'))).rows;
    }
    requests.push(request);
    const wait = delayMs(request);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    completed++;
    const answer = request.kind === 'label'
      ? Object.fromEntries(request.rows.map(([id, title]) => [String(id), labelFor(title)]))
      : { folders: folders ? folders(request.rows) : request.rows.map(row => ({ name: folderName(row), ids: [row[0]] })) };
    return {
      ok: true,
      async json() {
        return {
          model: payload.model,
          choices: [{ message: { content: JSON.stringify(answer) } }],
          usage
        };
      }
    };
  };
  return {
    requests,
    labelRequests: () => requests.filter(request => request.kind === 'label'),
    consolidations: () => requests.filter(request => request.kind === 'consolidate'),
    completed: () => completed,
    restore() { globalThis.fetch = original; }
  };
}

function membership(groups) {
  return groups.map(group => [group.name, [...group.tabIds].sort((a, b) => a - b)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

async function waitFor(check, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
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

test('cloud label rows cap titles and use compact local ordinals without URL fragments', () => {
  const longTitle = `Detailed task ${'context '.repeat(30)}— Site`;
  const tabs = [
    { id: 98273465, title: longTitle, url: 'https://app.example.com/projects/1234567890123456/details?q=private+search', active: true },
    { id: 11223344, title: 'Second title', url: 'https://example.com/#/settings', active: false }
  ];
  const prompt = buildLabelPrompt(tabs, 'rows');
  const rows = formatLabelRows(tabs);

  assert.deepEqual(rows.map(row => row[0]), [0, 1]);
  assert.ok(prompt.includes(longTitle.slice(0, PROMPT_TITLE_LIMIT).trim()));
  assert.ok(!prompt.includes(longTitle));
  assert.ok(!prompt.includes('98273465'));
  assert.ok(!prompt.includes('private'));
  assert.ok(prompt.includes('app.example.com/projects/:id/details'));
  assert.ok(prompt.includes('example.com'));
  assert.ok(!prompt.includes('#/settings'));
  assert.equal(sanitizeSemanticUrl('https://example.com/#/settings'), 'example.com#/settings');
});

test('group ranges follow the ceiling and quality flags only real problems', () => {
  assert.deepEqual(getAdaptiveGroupRange(34), { min: 1, max: 8 });
  assert.deepEqual(getAdaptiveGroupRange(105), { min: 1, max: 10 });

  const ids = (start, count) => Array.from({ length: count }, (_, index) => start + index);
  const eleven = Array.from({ length: 11 }, (_, index) => ({
    name: `Topic ${index + 1}`,
    tabIds: ids(index * 10 + 1, index === 10 ? 5 : 10)
  }));
  assert.ok(assessGroupingQuality(eleven, 105).codes.includes('too_many'));

  const three = assessGroupingQuality([
    { name: 'Coding', tabIds: ids(1, 5) },
    { name: 'Travel', tabIds: ids(6, 5) },
    { name: 'News', tabIds: ids(11, 5) }
  ], 105);
  assert.deepEqual(three.codes, []);

  const broad = assessGroupingQuality([
    { name: 'Learning', tabIds: ids(1, 24) },
    { name: 'Coding', tabIds: ids(25, 10) }
  ], 105);
  assert.ok(broad.issues.some(issue => issue.includes('too broad at 24 tabs')));

  const vague = assessGroupingQuality([
    { name: 'General', tabIds: ids(1, 7) },
    { name: 'Video', tabIds: ids(8, 8) }
  ], 34);
  assert.equal(vague.passed, false);
  assert.ok(vague.codes.includes('generic'));
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

test('a regional consolidation name is rejected locally without a retry', async () => {
  const tabs = [
    { id: 41, windowId: 14, index: 0, active: true, pinned: false, incognito: false, title: 'Italian Government', url: 'https://www.governo.it/' },
    { id: 42, windowId: 14, index: 1, active: false, pinned: false, incognito: false, title: 'University of Lisbon', url: 'https://www.ulisboa.pt/' },
    { id: 43, windowId: 14, index: 2, active: false, pinned: false, incognito: false, title: 'Polish Government', url: 'https://www.gov.pl/' },
    { id: 44, windowId: 14, index: 3, active: false, pinned: false, incognito: false, title: 'University of Warsaw', url: 'https://www.uw.edu.pl/' }
  ];
  installBrowser(tabs);
  const cloud = installCloudFetch({
    folders: rows => [{ name: 'Southern Europe', ids: rows.map(row => row[0]) }]
  });

  try {
    const result = await executeTabGrouping(14, {
      provider: 'groq',
      groqApiKey: 'test-only',
      groqModel: 'qwen/qwen3.8-27b'
    });

    assert.equal(cloud.labelRequests().length, 1);
    assert.equal(cloud.consolidations().length, 1);
    assert.equal(cloud.requests.length, 2, 'no retry after the rejected name');
    assert.ok(!result.groups.some(group => group.name === 'Southern Europe'));
    assert.deepEqual(result.groups.map(group => group.name), ['Admin & Learning']);
    assert.ok(!result.qualityCodes.includes('regional'));
  } finally {
    cloud.restore();
  }
});

test('the planner never produces Other, even when the model answers nonsense', async () => {
  const tabs = [
    ...['a', 'b', 'c'].map((slug, index) => ({
      id: 61 + index, windowId: 15, index, active: index === 0, pinned: false, incognito: false,
      title: `Issue ${slug}`, url: `https://github.com/org/repo/issues/${slug}`
    })),
    ...['a', 'b', 'c'].map((slug, index) => ({
      id: 64 + index, windowId: 15, index: index + 3, active: false, pinned: false, incognito: false,
      title: `Inbox ${slug}`, url: `https://mail.google.com/mail/u/0/${slug}`
    }))
  ];
  installBrowser(tabs);
  const cloud = installCloudFetch({
    labelFor: () => 'other',
    folders: rows => [{ name: 'Other', ids: rows.map(row => row[0]) }]
  });

  try {
    const result = await executeTabGrouping(15, { provider: 'openai', openaiApiKey: 'test-only' });
    assert.equal(cloud.labelRequests().length, 1);
    assert.ok(result.groups.length >= 1);
    assert.ok(result.groups.length <= groupCeiling(6));
    assert.ok(!result.groups.some(group => /^other$/i.test(group.name)));
    assert.deepEqual(result.groups.flatMap(group => group.tabIds).sort((a, b) => a - b), tabs.map(tab => tab.id));
    // Nonsense labels leave every tab placed by address, to be relabelled later.
    assert.equal(result.provisionalTabs, 6);
  } finally {
    cloud.restore();
  }
});

test('Socials and explicit rules are locked whatever the labels say', async () => {
  const makeTabs = () => [
    { id: 1, windowId: 9, index: 0, active: true, pinned: false, incognito: false, title: 'Home / X', url: 'https://x.com/home' },
    { id: 2, windowId: 9, index: 1, active: false, pinned: false, incognito: false, title: '/r/Chrome', url: 'https://www.reddit.com/r/chrome/' },
    { id: 3, windowId: 9, index: 2, active: false, pinned: false, incognito: false, title: 'Dashboard | Pathfinder', url: 'https://unifi.ui.com/consoles/pathfinder/protect/dashboard' },
    { id: 4, windowId: 9, index: 3, active: false, pinned: false, incognito: false, title: 'Billing', url: 'https://secure.backblaze.com/billing_card.htm' }
  ];
  const settings = { provider: 'groq', groqApiKey: 'test-only', groqModel: 'qwen/qwen3.8-27b' };

  // Without rules: K = 2 for 4 tabs, so Socials plus one group.
  installBrowser(makeTabs());
  let cloud = installCloudFetch({ labelFor: () => 'admin' });
  try {
    const result = await executeTabGrouping(9, settings);
    assert.equal(result.groups.length, 2);
    assert.deepEqual(result.groups.find(group => group.name === 'Socials')?.tabIds, [1, 2]);
    assert.deepEqual(cloud.labelRequests()[0].rows.map(row => row[1]).sort(), ['Billing', 'Dashboard | Pathfinder']);
  } finally {
    cloud.restore();
  }

  // A manual rule wins over the label; with 2 locked groups at K = 2 the
  // remaining tab forms one more group and the run is flagged.
  const { local } = installBrowser(makeTabs());
  local.foldnex_learning_schema_version = 2;
  local.foldnex_learned_rules = [{
    pattern: 'unifi.ui.com/*', category: 'Network', color: 'cyan', confidence: 1,
    matchCount: 1, userOverride: true, source: 'manual_rule', schemaVersion: 2
  }];
  cloud = installCloudFetch({ labelFor: () => 'infra' });
  try {
    const result = await executeTabGrouping(9, settings);
    assert.deepEqual(result.groups.find(group => group.name === 'Socials')?.tabIds, [1, 2]);
    assert.deepEqual(result.groups.find(group => group.name === 'Network')?.tabIds, [3]);
    assert.equal(result.groups.length, 3);
    assert.ok(result.qualityFlags.includes('rules_exceed_ceiling'));
    assert.deepEqual(cloud.labelRequests()[0].rows.map(row => row[1]), ['Billing']);
  } finally {
    cloud.restore();
  }
});

test('label requests keep ordinals local and follow provider request shapes', async () => {
  const tabs = [
    { id: 700001, title: 'Issue implementation', url: 'https://github.com/org/repo/issues/1' },
    { id: 700002, title: 'Easy ramen recipe', url: 'https://docs.example.com/api' }
  ];

  let cloud = installCloudFetch({
    usage: { prompt_tokens: 140, completion_tokens: 24, total_tokens: 164, prompt_tokens_details: { cached_tokens: 64 } }
  });
  try {
    const groq = await labelTabsWithAI(tabs, { provider: 'groq', groqApiKey: 'test-only', groqModel: 'openai/gpt-oss-20b' });
    assert.deepEqual([...groq.labels], [[700001, 'dev'], [700002, 'food']]);
    assert.equal(groq.meta.usage.cachedTokens, 64);
    const [{ payload }] = cloud.requests;
    assert.equal(payload.response_format.type, 'json_object');
    assert.equal(payload.reasoning_effort, 'low');
    assert.ok(payload.max_completion_tokens <= 1536);
    assert.ok(!JSON.stringify(payload).includes('700001'));
  } finally {
    cloud.restore();
  }

  cloud = installCloudFetch();
  try {
    await labelTabsWithAI(tabs, { provider: 'openai', openaiApiKey: 'test-only', openaiModel: 'gpt-5.4-nano', openaiPriority: false });
    await labelTabsWithAI(tabs, { provider: 'openai', openaiApiKey: 'test-only', openaiPriority: true });
    await labelTabsWithAI(tabs, {
      provider: 'deepseek', deepseekApiKey: 'test-only', deepseekModel: 'deepseek-flash', deepseekReasoningEffort: 'max'
    });
    const [nano, priority, deepseek] = cloud.requests.map(request => request.payload);
    assert.equal('temperature' in nano, false);
    assert.equal(nano.reasoning_effort, 'low');
    assert.equal(nano.messages[0].role, 'developer');
    assert.equal('service_tier' in nano, false);
    assert.equal(priority.service_tier, 'priority');
    assert.equal(priority.prompt_cache_key, 'foldnex-labels');
    assert.equal(deepseek.reasoning_effort, 'max');
    assert.equal(deepseek.max_tokens, 8192);
  } finally {
    cloud.restore();
  }
});

test('OpenAI reasoning models omit temperature and request low reasoning effort', () => {
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
});

test('OpenAI Responses-only Pro models fail early with a clear model error', async () => {
  assert.equal(isOpenAIResponsesOnlyModel('gpt-5-pro'), true);
  assert.equal(isOpenAIResponsesOnlyModel('gpt-5.4-pro-2026-03-05'), true);
  assert.deepEqual(getReasoningEffortOptions('openai', 'gpt-5-pro'), []);
  await assert.rejects(
    labelTabsWithAI([
      { id: 1, title: 'Code', url: 'https://example.com/code' },
      { id: 2, title: 'Docs', url: 'https://example.com/docs' }
    ], { provider: 'openai', openaiApiKey: 'test-only', openaiModel: 'gpt-5-pro' }),
    /requires the OpenAI Responses API/
  );
});

test('OpenAI defaults to GPT-6 Luna at low effort and offers its documented efforts', () => {
  assert.equal(PROVIDER_CATALOG.openai.defaultModel, 'gpt-6-luna');
  assert.deepEqual(
    getReasoningEffortOptions('openai', 'gpt-6-luna'),
    ['none', 'low', 'medium', 'high', 'xhigh', 'max']
  );
  assert.equal(getEffectiveReasoningEffort('openai', 'gpt-6-luna'), 'low');
  assert.equal(getEffectiveReasoningEffort('openai', 'gpt-6-luna', 'none'), 'none');
  assert.deepEqual(getCompatibleRequestControls('openai', 'gpt-6-luna'), { reasoning_effort: 'low' });
});

test('model-aware reasoning options constrain saved values to documented provider support', () => {
  assert.deepEqual(getReasoningEffortOptions('gemini_api', 'gemini-2.5-flash-lite'), ['low', 'medium', 'high']);
  assert.deepEqual(getReasoningEffortOptions('gemini_api', 'gemini-3.5-flash'), ['low', 'medium', 'high']);
  assert.deepEqual(getReasoningEffortOptions('gemini_api', 'gemini-3-pro-preview'), ['low', 'high']);
  assert.deepEqual(getReasoningEffortOptions('gemini_api', 'gemini-flash-lite-latest'), []);
  assert.equal(getEffectiveReasoningEffort('gemini_api', 'gemini-flash-lite-latest', 'high'), 'low');
  assert.equal(getEffectiveReasoningEffort('gemini_api', 'gemini-unknown-latest', 'high'), null);

  assert.deepEqual(getReasoningEffortOptions('deepseek', 'deepseek-flash'), ['low', 'high', 'max']);
  assert.equal(getEffectiveReasoningEffort('deepseek', 'deepseek-flash', 'medium'), 'low');
  assert.equal(getEffectiveReasoningEffort('deepseek', 'deepseek-flash', 'high'), 'high');
  assert.equal(getEffectiveReasoningEffort('deepseek', 'deepseek-flash', 'max'), 'max');

  assert.deepEqual(getReasoningEffortOptions('cerebras', 'gpt-oss-120b'), ['low', 'medium', 'high']);
  assert.deepEqual(getReasoningEffortOptions('cerebras', 'qwen-3.8-27b'), ['low', 'medium', 'high']);
  assert.deepEqual(getReasoningEffortOptions('cerebras', 'zai-glm-4.7'), []);
  assert.equal(getEffectiveReasoningEffort('cerebras', 'zai-glm-4.7', 'low'), null);
  assert.deepEqual(getReasoningEffortOptions('ollama', 'qwen3:8b'), ['low', 'medium', 'high']);
  assert.deepEqual(getReasoningEffortOptions('xai', 'grok-4.5'), ['low', 'medium', 'high']);
  assert.deepEqual(getReasoningEffortOptions('xai', 'grok-4.6'), ['low', 'medium', 'high', 'xhigh']);
  assert.equal(getEffectiveReasoningEffort('xai', 'grok-4.7', 'xhigh'), 'xhigh');
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

  assert.equal(isCompatibleReasoningModel('cerebras', 'qwen-3.8-27b'), true);
  assert.deepEqual(getCompatibleRequestControls('cerebras', 'qwen-3.8-27b'), { temperature: 0, reasoning_effort: 'low' });
  assert.deepEqual(getCompatibleRequestControls('deepseek', 'deepseek-flash', 'max'), {
    reasoning_effort: 'max', thinking: { type: 'enabled' }
  });
  assert.deepEqual(getCompatibleRequestControls('xai', 'grok-4.7', 'xhigh'), { reasoning_effort: 'xhigh' });
  assert.equal(isCompatibleReasoningModel('cerebras', 'zai-glm-4.7'), false);
  assert.deepEqual(getCompatibleRequestControls('cerebras', 'zai-glm-4.7'), { temperature: 0 });
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
    }, 'high'),
    {
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingLevel: 'HIGH' }
    }
  );
  assert.deepEqual(
    getGeminiGenerationConfig('gemini-2.5-flash-lite', {}, 'medium'),
    { thinkingConfig: { thinkingBudget: 8192 } }
  );
  assert.deepEqual(
    getGeminiGenerationConfig('gemini-2.5-flash-lite', {}, 'high'),
    { thinkingConfig: { thinkingBudget: 24576 } }
  );
  assert.deepEqual(
    getGeminiGenerationConfig('gemini-2.0-flash', { temperature: 0.2 }),
    { temperature: 0.2 }
  );
});

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

test('orchestrator scopes exact cache and diagnostics by effective reasoning effort', async () => {
  const tabs = makeTopicTabs(5, 100, { video: 4, design: 4 });
  const { local, calls } = installBrowser(tabs);
  const cloud = installCloudFetch({
    usage: {
      prompt_tokens: 220,
      completion_tokens: 48,
      total_tokens: 268,
      completion_tokens_details: { reasoning_tokens: 64 }
    }
  });
  const settings = {
    provider: 'groq',
    groqApiKey: 'test-only',
    groqModel: 'openai/gpt-oss-20b',
    groqReasoningEffort: 'medium',
    collapseGroupsOnCreation: false
  };

  try {
    const first = await executeTabGrouping(5, settings);
    assert.equal(first.source, 'cloud');
    assert.equal(first.groupsCreated, 2);
    assert.equal(cloud.labelRequests().length, 1);
    assert.equal(cloud.consolidations().length, 1);
    assert.equal(cloud.labelRequests()[0].payload.reasoning_effort, 'medium');
    assert.deepEqual(first.groups.map(group => group.name).sort(), ['Design References', 'Video Production']);
    assert.equal(local.foldnex_last_run.promptTokens, 440);
    assert.equal(local.foldnex_last_run.reasoningEffort, 'medium');
    assert.equal(local.foldnex_last_run.reasoningTokens, 128);
    assert.equal((await LearningCache.getRules()).length, 0);

    const second = await executeTabGrouping(5, settings);
    assert.equal(second.source, 'exact-cache');
    assert.equal(second.groupsCreated, 2);
    assert.equal(cloud.requests.length, 2);
    assert.equal(local.foldnex_last_run.reasoningEffort, null);
    assert.equal(local.foldnex_last_run.reasoningTokens, null);

    // A new effort is a new exact-cache scope, but labels and names carry over.
    const highEffort = await executeTabGrouping(5, { ...settings, groqReasoningEffort: 'high' });
    assert.equal(highEffort.source, 'label-cache');
    assert.equal(cloud.requests.length, 2);
    assert.deepEqual(membership(highEffort.groups), membership(first.groups));
    assert.equal(calls.update.length, 6);
  } finally {
    cloud.restore();
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
  resetNanoBases();
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
    assert.equal(unavailableResult.fallbackCode, 'nano_unavailable');
    assert.ok(unavailableResult.groups.length <= groupCeiling(2));
    assert.ok(!unavailableResult.groups.some(group => /^other$/i.test(group.name)));

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
    assert.ok(failedRuntimeResult.groups.length <= groupCeiling(2));
    assert.ok(!failedRuntimeResult.groups.some(group => /^other$/i.test(group.name)));
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    resetNanoBases();
    if (hadSelf) globalThis.self = originalSelf;
    else delete globalThis.self;
    if (hadLanguageModel) globalThis.LanguageModel = originalLanguageModel;
    else delete globalThis.LanguageModel;
  }
});

test('click budget counts down and aborts before its deadline', async () => {
  let clock = 1000;
  const budget = createClickBudget(4500, () => clock);
  assert.equal(budget.deadline, 5500);
  assert.equal(budget.remaining(), 4500);
  clock = 5000;
  assert.equal(budget.remaining(), 500);
  assert.equal(budget.abortAt(600).aborted, true, 'already inside the reserve');
  clock = 7000;
  assert.equal(budget.remaining(), 0);

  const live = createClickBudget(60);
  const signal = live.abortAt(20);
  assert.equal(signal.aborted, false);
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(signal.aborted, true);
  live.dispose();
});

test('Nano warm path: the second click makes no prompts and keeps names and membership', async () => {
  const tabs = makeTopicTabs(40, 1000, { food: 10, travel: 10, dev: 10 });
  const { local } = installBrowser(tabs);
  const nano = installNanoMock({ nameFor: name => `${name} Hub` });
  try {
    const first = await executeTabGrouping(40, { provider: 'gemini_nano' });
    assert.equal(first.source, 'nano');
    assert.equal(first.provisionalTabs, 0);
    assert.ok(nano.labelPrompts.length >= 2);
    assert.ok(nano.labelPrompts.every(prompt => prompt.text.split('\n').length - 1 <= 20));
    assert.equal(nano.namePrompts.length, 1);
    assert.ok(first.groups.some(group => group.name === 'Food & Recipes Hub'));
    assert.equal(nano.create[0].topK, 1);
    assert.equal(nano.create[0].temperature, 0);

    await ExactResultCache.clear();
    const labelPrompts = nano.labelPrompts.length;
    const second = await executeTabGrouping(40, { provider: 'gemini_nano' });
    assert.equal(second.source, 'label-cache');
    assert.equal(nano.labelPrompts.length, labelPrompts);
    assert.equal(nano.namePrompts.length, 1);
    assert.deepEqual(membership(second.groups), membership(first.groups));
    assert.equal(second.nameSources.memory, 3);
    assert.equal(local.foldnex_last_run.modelCalls.label, 0);
  } finally {
    removeNanoMock();
  }
});

test('a click that reaches its deadline places the rest provisionally and caches nothing provisional', async () => {
  const tabs = makeTopicTabs(41, 1100, { food: 10, travel: 10, dev: 10 });
  const { local } = installBrowser(tabs);
  // A fast stored estimate, so the budget fits one batch that then hangs.
  local.foldnex_nano_perf_v1 = { overheadMs: 200, msPerTab: 60 };
  const nano = installNanoMock({ hangLabels: true });
  try {
    const startedAt = Date.now();
    const result = await executeTabGrouping(41, { provider: 'gemini_nano' }, { budgetMs: 1200 });
    assert.ok(Date.now() - startedAt < 1500, 'the click resolves within its budget');
    assert.equal(nano.labelPrompts.length, 1);
    assert.equal(nano.aborts, 1, 'the in-flight prompt was aborted');
    assert.equal(result.deadlineHit, true);
    assert.equal(result.provisionalTabIds.length, 30);
    assert.ok(result.groups.length <= groupCeiling(30));
    assert.deepEqual(result.groups.flatMap(group => group.tabIds).sort((a, b) => a - b), tabs.map(tab => tab.id));
    assert.equal(local.foldnex_exact_results_v1, undefined);
    assert.equal(local[TabLabelCache.STORAGE_KEY], undefined);
    assert.equal(local.foldnex_last_run.deadlineHit, true);

    // A budget too small for any batch never prompts at all.
    const tight = await executeTabGrouping(41, { provider: 'gemini_nano' }, { budgetMs: 300 });
    assert.equal(nano.labelPrompts.length, 1);
    assert.equal(tight.deadlineHit, true);
    assert.equal(tight.provisionalTabs, 30);
  } finally {
    removeNanoMock();
  }
});

test('a cold model does not hold the click and the background reuses the same load', async () => {
  const tabs = makeTopicTabs(42, 1200, { food: 3, travel: 3 });
  installBrowser(tabs, { sync: { provider: 'gemini_nano' } });
  const nano = installNanoMock({ create: () => new Promise(() => {}) });
  try {
    const startedAt = Date.now();
    const result = await executeTabGrouping(42, { provider: 'gemini_nano' }, { budgetMs: 3300 });
    assert.ok(Date.now() - startedAt < 3300);
    assert.equal(result.fallbackCode, 'nano_loading');
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.provisionalTabs, 6);
    assert.equal(nano.create.length, 1);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const background = await classifyTabs(tabs.map(tab => tab.id), controller.signal);
    assert.equal(background.aborted, true);
    assert.equal(nano.create.length, 1, 'the pending load is shared, not restarted');
  } finally {
    removeNanoMock();
  }
});

test('cloud labels for 60 tabs use three enum-schema batches and one consolidation', async () => {
  const tabs = makeTopicTabs(43, 1300, { food: 20, travel: 20, dev: 20 });
  installBrowser(tabs);
  const cloud = installCloudFetch();
  const settings = { provider: 'openai', openaiApiKey: 'test-only', openaiReasoningEffort: 'medium' };
  try {
    const result = await executeTabGrouping(43, settings);
    const labels = cloud.labelRequests();
    assert.deepEqual(labels.map(request => request.rows.length).sort((a, b) => b - a), [25, 25, 10]);
    for (const { payload } of labels) {
      assert.equal(payload.response_format.type, 'json_schema');
      assert.equal(payload.response_format.json_schema.strict, true);
      assert.deepEqual(payload.response_format.json_schema.schema.properties['0'].enum, [...CATEGORY_KEYS]);
      assert.equal(payload.prompt_cache_key, 'foldnex-labels');
      assert.equal(payload.reasoning_effort, 'medium');
    }
    assert.ok(cloud.consolidations().length <= 1);
    for (const { payload } of cloud.consolidations()) assert.equal(payload.prompt_cache_key, 'foldnex-consolidate');
    assert.ok(result.groups.length <= 10);
    assert.equal(result.groups.flatMap(group => group.tabIds).length, 60);

    // Labels are context-free: one big batch gives the same labels and plan.
    const batched = await labelTabsWithAI(tabs, settings);
    const single = await labelTabsWithAI(tabs, settings, { batchSize: 100 });
    assert.deepEqual([...single.labels], [...batched.labels]);
    assert.deepEqual(
      membership(planGroups(tabs, single.labels).groups),
      membership(planGroups(tabs, batched.labels).groups)
    );
  } finally {
    cloud.restore();
  }
});

test('a late consolidation keeps the deterministic plan now and names the next click', async () => {
  const tabs = makeTopicTabs(44, 1400, { food: 4, travel: 4, dev: 4 });
  const { local } = installBrowser(tabs);
  const cloud = installCloudFetch({ delayMs: request => (request.kind === 'consolidate' ? 2200 : 0) });
  const settings = { provider: 'openai', openaiApiKey: 'test-only' };
  try {
    const startedAt = Date.now();
    const first = await executeTabGrouping(44, settings, { budgetMs: 2000 });
    assert.ok(Date.now() - startedAt < 2000);
    assert.ok(first.qualityFlags.includes('consolidation_timeout'));
    assert.equal(first.deadlineHit, true);
    assert.equal(cloud.consolidations().length, 1);
    assert.deepEqual(first.groups.map(group => group.name).sort(), ['Coding', 'Food & Recipes', 'Travel']);
    assert.equal(local.foldnex_exact_results_v1, undefined);

    // The late answer is validated and remembered, not applied.
    assert.ok(await waitFor(async () => (await PlanMemory.read()).names.length === 3));

    await ExactResultCache.clear();
    const second = await executeTabGrouping(44, settings);
    assert.equal(cloud.labelRequests().length, 1);
    assert.equal(cloud.consolidations().length, 1);
    assert.equal(second.source, 'label-cache');
    assert.deepEqual(second.groups.map(group => group.name).sort(), ['Home Cooking', 'Japan Trip', 'React App']);
  } finally {
    cloud.restore();
  }
});

test('a prepared window waits briefly for names and remembers a late answer', async () => {
  const tabs = makeTopicTabs(45, 1450, { food: 4, travel: 4, dev: 4 });
  const { local } = installBrowser(tabs);
  const cloud = installCloudFetch({ delayMs: request => (request.kind === 'consolidate' ? 2200 : 0) });
  const settings = { provider: 'openai', openaiApiKey: 'test-only' };
  try {
    // Warm the label cache, then forget the names so the next click needs them again.
    await executeTabGrouping(45, settings, { budgetMs: 2000 });
    assert.ok(await waitFor(async () => (await PlanMemory.read()).names.length === 3));
    delete local.foldnex_plan_memory_v1;
    await ExactResultCache.clear();

    const startedAt = Date.now();
    const prepared = await executeTabGrouping(45, settings);
    assert.equal(prepared.source, 'label-cache');
    assert.ok(Date.now() - startedAt < PREPARED_NAMING_WAIT_MS + 700, 'no wait for a slow consolidation');
    assert.ok(prepared.qualityFlags.includes('consolidation_timeout'));
    assert.deepEqual(prepared.groups.map(group => group.name).sort(), ['Coding', 'Food & Recipes', 'Travel']);
    assert.ok(await waitFor(async () => (await PlanMemory.read()).names.length === 3));
  } finally {
    cloud.restore();
  }
});

test('Groq label and consolidation requests use JSON object mode', async () => {
  const tabs = makeTopicTabs(45, 1500, { food: 3, travel: 3 });
  installBrowser(tabs);
  const cloud = installCloudFetch();
  try {
    await executeTabGrouping(45, { provider: 'groq', groqApiKey: 'test-only', groqModel: 'openai/gpt-oss-20b' });
    assert.equal(cloud.labelRequests().length, 1);
    assert.equal(cloud.consolidations().length, 1);
    for (const { payload } of cloud.requests) {
      assert.equal(payload.response_format.type, 'json_object');
      assert.equal(payload.messages.length, 1);
      assert.equal(payload.messages[0].role, 'user');
    }
  } finally {
    cloud.restore();
  }
});

test('an empty consolidation answer leaves the plan untouched', async () => {
  const tabs = makeTopicTabs(49, 1550, { food: 3, travel: 3, dev: 3 });
  const { local } = installBrowser(tabs);
  const cloud = installCloudFetch({ folders: () => [] });
  try {
    const result = await executeTabGrouping(49, { provider: 'openai', openaiApiKey: 'test-only' });
    assert.equal(cloud.consolidations().length, 1);
    assert.ok(result.qualityFlags.includes('consolidation_failed'));
    assert.deepEqual(result.groups.map(group => group.name).sort(), ['Coding', 'Food & Recipes', 'Travel']);
    // Unnamed groups are not reused, so the next click retries consolidation.
    assert.equal(local.foldnex_exact_results_v1, undefined);
    const second = await executeTabGrouping(49, { provider: 'openai', openaiApiKey: 'test-only' });
    assert.equal(second.source, 'label-cache');
    assert.equal(cloud.consolidations().length, 2);
  } finally {
    cloud.restore();
  }
});

test('the label cache sends only new tabs and respects which engine wrote a label', async () => {
  const tabs = makeTopicTabs(21, 5000, { food: 6 });
  installBrowser(tabs);
  let cloud = installCloudFetch();
  const settings = { provider: 'openai', openaiApiKey: 'test-only' };

  try {
    await executeTabGrouping(21, settings);
    assert.equal(cloud.labelRequests().length, 1);
    assert.equal(cloud.labelRequests()[0].rows.length, 6);

    tabs.push({ ...makeTopicTabs(21, 5100, { travel: 1 })[0], index: 6, active: false });
    const second = await executeTabGrouping(21, settings);
    assert.equal(cloud.labelRequests().length, 2);
    assert.deepEqual(cloud.labelRequests()[1].rows.map(row => row[1]), ['Cheap flights to Tokyo 0']);
    assert.equal(second.source, 'cloud');

    const third = await executeTabGrouping(21, settings);
    assert.equal(cloud.labelRequests().length, 2);
    assert.equal(third.source, 'exact-cache');

    // Labels a cloud engine wrote are good enough for Nano.
    const nano = installNanoMock();
    try {
      const local = await executeTabGrouping(21, { provider: 'gemini_nano' });
      assert.equal(nano.labelPrompts.length, 0);
      assert.equal(local.source, 'label-cache');
    } finally {
      removeNanoMock();
    }
  } finally {
    cloud.restore();
  }

  // Nano-quality labels are never silently reused by a cloud engine.
  const fresh = makeTopicTabs(22, 5200, { food: 3, travel: 3 });
  installBrowser(fresh);
  const nano = installNanoMock();
  cloud = installCloudFetch();
  try {
    await executeTabGrouping(22, { provider: 'gemini_nano' });
    assert.ok(nano.labelPrompts.length > 0);
    await executeTabGrouping(22, settings);
    assert.equal(cloud.labelRequests().length, 1);
    assert.equal(cloud.labelRequests()[0].rows.length, 6);
  } finally {
    cloud.restore();
    removeNanoMock();
  }
});

test('an incognito task run stores nothing', async () => {
  const tabs = makeTopicTabs(46, 1600, { food: 4, travel: 4 }, { incognito: true });
  const { local, session } = installBrowser(tabs);
  const nano = installNanoMock();
  try {
    const result = await executeTabGrouping(46, { provider: 'gemini_nano' });
    assert.ok(nano.labelPrompts.length > 0);
    assert.ok(result.groups.length >= 1);
    assert.deepEqual(local, {});
    assert.ok(!Object.keys(session).some(key => key.startsWith(WindowPlanStore.KEY_PREFIX)));
  } finally {
    removeNanoMock();
  }
});

test('run diagnostics hold counts and names, never titles or URLs', async () => {
  const tabs = makeTopicTabs(47, 1700, { food: 5, travel: 5, dev: 5 });
  const { local } = installBrowser(tabs);
  const nano = installNanoMock();
  try {
    await executeTabGrouping(47, { provider: 'gemini_nano' });
    const run = local.foldnex_last_run;
    assert.ok(nano.labelPrompts.length > 0);
    assert.equal(run.groupCeiling, groupCeiling(15));
    assert.equal(run.provisionalTabs, 0);
    assert.equal(run.labelSources.model, 15);
    assert.deepEqual(Object.keys(run.labelSources).sort(), ['cache', 'lexicon', 'model', 'review', 'site', 'siteAffinity', 'tokenAttach']);
    assert.deepEqual(Object.keys(run.modelCalls).sort(), ['consolidation', 'label', 'naming']);
    assert.deepEqual(Object.keys(run.nameSources).sort(), ['deterministic', 'memory', 'model', 'user']);
    assert.equal(run.deadlineHit, false);
    assert.equal(run.budgetMs, 4500);
    const stored = JSON.stringify(run);
    for (const tab of tabs) {
      assert.ok(!stored.includes(tab.title));
      assert.ok(!stored.includes(tab.url));
    }
  } finally {
    removeNanoMock();
  }
});

test('offline smart mode plans locally within the ceiling and never calls a model', async () => {
  const words = ['Quarterly notes', 'Garden ideas', 'Weekend recipe', 'Budget sheet', 'Flight options'];
  const tabs = Array.from({ length: 50 }, (_, index) => ({
    id: 2000 + index,
    windowId: 48,
    index,
    active: index === 0,
    pinned: false,
    incognito: false,
    title: `${words[index % words.length]} ${index}`,
    url: `https://${index % 3 === 0 ? 'shared-portal' : `one-off-${index}`}.example-${index % 3 === 0 ? 'x' : index}.org/page/${index}`
  }));
  installBrowser(tabs);
  const nano = installNanoMock();
  const cloud = installCloudFetch();
  try {
    const result = await executeTabGrouping(48, { provider: 'offline' });
    assert.equal(result.source, 'offline');
    assert.ok(result.groups.length <= 10);
    assert.ok(!result.groups.some(group => /^other$/i.test(group.name)));
    assert.equal(result.provisionalTabs, 0);
    assert.equal(cloud.requests.length, 0);
    assert.equal(nano.labelPrompts.length + nano.namePrompts.length, 0);
    assert.deepEqual(result.groups.flatMap(group => group.tabIds).sort((a, b) => a - b), tabs.map(tab => tab.id));
  } finally {
    cloud.restore();
    removeNanoMock();
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

test('background labelling stores every batch, the plan refresh names once, and the click is warm', async () => {
  const tabs = makeTopicTabs(50, 3000, { food: 10, travel: 10, dev: 10 });
  const { calls, session } = installBrowser(tabs, { sync: { provider: 'gemini_nano' } });
  const nano = installNanoMock({ nameFor: name => `${name} Hub` });
  try {
    const result = await classifyTabs(tabs.map(tab => tab.id));
    assert.deepEqual(result.windowIds, [50]);
    assert.deepEqual(nano.labelPrompts.map(prompt => prompt.text.split('\n').length - 1), [16, 14]);
    assert.equal(calls.labelStores, 2, 'each batch is stored as soon as it lands');

    const plan = await refreshWindowPlan(50, { provider: 'gemini_nano' });
    assert.equal(nano.namePrompts.length, 1);
    assert.ok(session[WindowPlanStore.keyFor(50)]);
    assert.deepEqual((await WindowPlanStore.get(50)).signature, plan.signature);

    const click = await executeTabGrouping(50, { provider: 'gemini_nano' });
    assert.equal(nano.labelPrompts.length, 2);
    assert.equal(nano.namePrompts.length, 1);
    assert.equal(click.source, 'label-cache');
    assert.ok(click.groups.some(group => group.name === 'Coding Hub'));
  } finally {
    removeNanoMock();
  }
});

test('background classifier never sends tabs to a cloud engine unless auto-grouping is on', async () => {
  const tabs = makeTopicTabs(51, 3100, { food: 3, travel: 3 });
  installBrowser(tabs, { sync: { provider: 'openai', openaiApiKey: 'test-only' } });
  let cloud = installCloudFetch();
  try {
    await classifyTabs(tabs.map(tab => tab.id));
    assert.equal(cloud.requests.length, 0);
  } finally {
    cloud.restore();
  }

  installBrowser(tabs, { sync: { provider: 'openai', openaiApiKey: 'test-only', autoGroupNewTabs: true } });
  cloud = installCloudFetch();
  try {
    await classifyTabs(tabs.map(tab => tab.id));
    assert.equal(cloud.labelRequests().length, 1);
    await refreshAndAutoGroup(51);
    assert.equal(cloud.consolidations().length, 0, 'the background never pays for consolidation');
    assert.equal(cloud.requests.length, 1);
  } finally {
    cloud.restore();
  }
});

test('auto-group joins matching groups, respects the ceiling and skips Review Later', async () => {
  const tabs = [
    ...makeTopicTabs(52, 3200, { food: 4, travel: 3 }),
    { id: 3299, windowId: 52, index: 7, pinned: false, incognito: false, status: 'complete', groupId: -1, title: 'Kitchen recipe 9', url: 'https://www.new-food-site.com/' }
  ];
  for (const tab of tabs.slice(0, 7)) tab.groupId = tab.title.includes('ramen') ? 77 : 78;
  const chromeGroups = [
    { id: 77, windowId: 52, title: 'Food & Recipes', color: 'orange' },
    { id: 78, windowId: 52, title: 'Travel', color: 'blue' }
  ];
  const { calls } = installBrowser(tabs, {
    sync: { provider: 'openai', openaiApiKey: 'test-only', autoGroupNewTabs: true },
    chromeGroups
  });
  const { fingerprintById } = await TabLabelCache.lookup(tabs);
  await TabLabelCache.store(new Map(tabs.map(tab => [tab.id, keyForTitle(tab.title)])), fingerprintById, 'openai');

  const plan = await refreshAndAutoGroup(52);
  assert.ok(plan.groups.some(group => group.name === 'Food & Recipes' && group.tabIds.includes(3299)));
  assert.equal((await WindowPlanStore.get(52)).groups.find(group => group.name === 'Food & Recipes').tabIds.length, 5);
  assert.deepEqual(calls.group, [{ groupId: 77, tabIds: [3299] }]);

  // At the ceiling, two new games tabs never create a group.
  const crowded = [
    ...Array.from({ length: 6 }, (_, index) => ({ id: 3400 + index, windowId: 53, index, groupId: 90 + index, title: `Tab ${index}`, url: `https://www.site-${index}.com/` })),
    { id: 3410, windowId: 53, index: 6, groupId: -1, title: 'Strategy game guide 1', url: 'https://www.games-1.com/' },
    { id: 3411, windowId: 53, index: 7, groupId: -1, title: 'Strategy game guide 2', url: 'https://www.games-2.com/' }
  ];
  const full = installBrowser(crowded, {
    chromeGroups: Array.from({ length: groupCeiling(8) }, (_, index) => ({ id: 90 + index, windowId: 53, title: `Group ${index}` }))
  });
  await autoGroupWindow(53, { groups: [{ name: 'Gaming', kind: 'category', tabIds: [3410, 3411] }] });
  assert.ok(!full.calls.group.some(call => call.createProperties));

  // Review Later is never auto-grouped, even with room below the ceiling.
  const review = installBrowser(crowded.map(tab => ({ ...tab, groupId: -1 })));
  await autoGroupWindow(53, { groups: [{ name: 'Review Later', kind: 'review', tabIds: [3410, 3411] }] });
  assert.deepEqual(review.calls.group, []);
});

test('prioritize moves a window to the front without flushing early', async () => {
  const tabs = [
    ...makeTopicTabs(54, 3500, { food: 2 }),
    ...makeTopicTabs(55, 3600, { travel: 2 })
  ];
  installBrowser(tabs, { sync: { backgroundPrep: true } });
  const seen = [];
  const classifier = createBackgroundClassifier({
    classify: async tabIds => {
      seen.push(tabIds);
      return { windowIds: [] };
    },
    refresh: async () => null,
    flushDelayMs: 60
  });

  classifier.enqueue([3500, 3501]);
  await classifier.prioritize(55);
  assert.deepEqual(classifier.pendingTabIds(), [3600, 3601, 3500, 3501]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(seen.length, 0, 'no flush before the debounce');
  assert.ok(await waitFor(() => seen.length === 1, 1000));
  assert.deepEqual(seen[0], [3600, 3601, 3500, 3501]);
});

test('pause aborts an in-flight background label prompt and requeues its tabs', async () => {
  const tabs = makeTopicTabs(56, 3700, { food: 3, dev: 3 });
  installBrowser(tabs, { sync: { provider: 'gemini_nano', backgroundPrep: true } });
  const nano = installNanoMock({ hangLabels: true });
  const classifier = createBackgroundClassifier({ refresh: async () => null, flushDelayMs: 10 });
  try {
    classifier.enqueue(tabs.map(tab => tab.id));
    assert.ok(await waitFor(() => nano.labelPrompts.length === 1, 2000));
    classifier.pause();
    assert.ok(await waitFor(() => classifier.pendingTabIds().length === tabs.length, 1000));
    assert.equal(nano.aborts, 1);
    assert.deepEqual(classifier.pendingTabIds().sort((a, b) => a - b), tabs.map(tab => tab.id));
  } finally {
    removeNanoMock();
  }
});

test('the store package lists every statically imported source file', async () => {
  const root = new URL('../', import.meta.url);
  const script = await readFile(new URL('scripts/package-store.sh', root), 'utf8');
  const start = script.indexOf('FILES=(') + 'FILES=('.length;
  const packaged = new Set(script.slice(start, script.indexOf(')', start)).split(/\s+/).filter(Boolean));
  const importPattern = /^\s*(?:import|export)\s[^'"]*?\sfrom\s+['"](\.{1,2}\/[^'"]+)['"]|^\s*import\s+['"](\.{1,2}\/[^'"]+)['"]/gm;

  const seen = new Set();
  const queue = ['background.js', 'popup.js', 'options/options.js'];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(new URL(file, root), 'utf8');
    for (const match of source.matchAll(importPattern)) {
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1] || match[2])));
    }
  }

  assert.ok(seen.has('src/planner.js'));
  for (const file of seen) assert.ok(packaged.has(file), `${file} is imported but not packaged`);
});

test('the setup card and unload setting offer exactly the stored preference values', async () => {
  const root = new URL('../', import.meta.url);
  const popup = await readFile(new URL('popup.html', root), 'utf8');
  const options = await readFile(new URL('options/options.html', root), 'utf8');

  // setupChoice is 'cloud' | 'nano' | 'offline'; 'keep' saves one of those for Ollama.
  const choices = [...popup.matchAll(/<button type="button"[^>]*class="setup-choice[^"]*"[^>]*data-choice="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(choices, ['cloud', 'nano', 'offline', 'keep']);

  const select = options.match(/<select id="prefModelUnloadAfter"[\s\S]*?<\/select>/)?.[0] || '';
  const values = [...select.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)];
  assert.deepEqual(values.map(match => match[1]), ['immediately', '2m', '5m', '15m', '60m', 'never']);
  assert.equal(values.find(match => match[1] === '5m')?.[2], 'After 5 minutes (default)');
  assert.match(options, /<input type="checkbox" id="prefBackgroundPrep"/);
});

// Last: background.js registers listeners and warms Nano when it is evaluated.
test('a user rename sticks to its group after a tab is added', async () => {
  const tabs = makeTopicTabs(60, 4000, { food: 5, travel: 5, dev: 5 });
  const { calls } = installBrowser(tabs, { sync: { provider: 'gemini_nano', groupingStrategy: 'task' } });
  const listeners = {};
  const event = name => ({ addListener(listener) { listeners[name] = listener; } });
  chrome.storage.local.setAccessLevel = async () => {};
  chrome.storage.onChanged = event('storageChanged');
  chrome.action = {
    onClicked: event('actionClicked'),
    async setBadgeText() {},
    async setBadgeBackgroundColor() {},
    async setPopup() {}
  };
  chrome.commands = { onCommand: event('command') };
  chrome.runtime = {
    onInstalled: event('installed'),
    onStartup: event('startup'),
    onMessage: event('message'),
    openOptionsPage() {}
  };
  chrome.tabs.onUpdated = event('tabUpdated');
  chrome.tabGroups.onUpdated = event('groupUpdated');
  chrome.tabGroups.onRemoved = event('groupRemoved');
  chrome.windows = { onRemoved: event('windowRemoved') };
  chrome.management = { async getSelf() { return { installType: 'normal' }; } };
  const nano = installNanoMock();

  try {
    await import('../background.js');
    assert.equal(typeof listeners.groupUpdated, 'function');

    const first = await executeTabGrouping(60, { provider: 'gemini_nano' });
    assert.equal(nano.namePrompts.length, 1);
    const foodIndex = first.groups.findIndex(group => group.name === 'Food & Recipes');
    assert.ok(foodIndex >= 0);
    const foodUpdate = calls.update.find(update => update.title === 'Food & Recipes');
    const group = { id: foodUpdate.id, windowId: 60, color: 'orange' };

    // Foldnex's own title event is ignored; the user's rename is learned.
    await listeners.groupUpdated({ ...group, title: 'Food & Recipes' });
    await listeners.groupUpdated({ ...group, title: 'Recipes' });
    const memory = await PlanMemory.read();
    const record = memory.names.find(item => item.s === 'user');
    assert.equal(record.n, 'Recipes');
    assert.deepEqual(record.k, ['cat:food']);
    assert.equal(record.f.length, 5);

    tabs.push({ ...makeTopicTabs(60, 4100, { food: 6 })[5], index: tabs.length, active: false });
    const second = await executeTabGrouping(60, { provider: 'gemini_nano' });
    const renamed = second.groups.find(item => item.tabIds.includes(4105));
    assert.equal(renamed.name, 'Recipes');
    assert.equal(renamed.tabIds.length, 6);
    assert.equal(nano.namePrompts.length, 1, 'no naming prompt on the second click');

    // PREPARE_GROUPING answers at once (By site category: nothing to prepare).
    await chrome.storage.sync.set({ groupingStrategy: 'site' });
    const response = await new Promise(resolve => {
      listeners.message({ type: 'PREPARE_GROUPING', windowId: 60 }, {}, resolve);
    });
    assert.deepEqual(response, { ok: true });

    await listeners.windowRemoved(60);
    await waitFor(async () => (await WindowPlanStore.get(60)) === null, 500);
    assert.equal(await WindowPlanStore.get(60), null);
  } finally {
    removeNanoMock();
  }
});

test('a slow cloud label batch is not aborted at the deadline and its late labels warm the next click', async () => {
  const tabs = makeTopicTabs(70, 7000, { food: 20, travel: 15, dev: 10 });
  const { local } = installBrowser(tabs);
  // 45 tabs make batches of 25 and 20; the 20-tab batch lands after the click stopped waiting.
  const cloud = installCloudFetch({ delayMs: request => (request.kind === 'label' && request.rows.length === 20 ? 2500 : 0) });
  const settings = { provider: 'openai', openaiApiKey: 'test-only', openaiReasoningEffort: 'medium' };
  try {
    const startedAt = Date.now();
    const first = await executeTabGrouping(70, settings, { budgetMs: 1500 });
    assert.ok(Date.now() - startedAt < 2200, 'the click does not wait for the slow batch');
    assert.equal(first.deadlineHit, true);
    assert.equal(first.fallbackUsed, false);
    assert.equal(first.provisionalTabs, 20);
    assert.equal(first.source, 'cloud');
    assert.equal(cloud.labelRequests().length, 2);
    assert.ok(cloud.labelRequests().every(request => !request.signal?.aborted), 'no label request is aborted');
    assert.equal(local.foldnex_last_run.labelSources.model, 25);
    assert.equal(local.foldnex_last_run.modelCalls.label, 2);
    assert.equal(local.foldnex_last_run.promptTokens, 10, 'usage of the batch that landed in time');
    assert.equal(local.foldnex_exact_results_v1, undefined);

    assert.ok(await waitFor(async () => Object.keys(await TabLabelCache.read()).length === 45, 5000), 'the late batch is cached');
    assert.equal(cloud.labelRequests().at(-1).signal.aborted, false);

    const second = await executeTabGrouping(70, settings);
    assert.equal(second.source, 'label-cache');
    assert.equal(second.provisionalTabs, 0);
    assert.equal(second.deadlineHit, false);
    assert.equal(cloud.labelRequests().length, 2, 'the next click sends no label request');
  } finally {
    cloud.restore();
  }

  // An incognito click never stores a late label, so it aborts at the deadline
  // and sends nothing when no time is left.
  const hidden = makeTopicTabs(71, 7100, { food: 3, travel: 3 }, { incognito: true });
  const { local: hiddenLocal } = installBrowser(hidden);
  const slow = installCloudFetch({ delayMs: request => (request.kind === 'label' ? 900 : 0) });
  try {
    const result = await executeTabGrouping(71, settings, { budgetMs: 1200 });
    assert.equal(result.deadlineHit, true);
    assert.equal(result.provisionalTabs, 6);
    assert.equal(slow.labelRequests().length, 1);
    assert.equal(slow.labelRequests()[0].signal.aborted, true, 'the incognito request is aborted');
    assert.ok(await waitFor(() => slow.completed() === 1));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(hiddenLocal, {});

    const late = await executeTabGrouping(71, settings, { budgetMs: 500 });
    assert.equal(late.deadlineHit, true);
    assert.equal(late.provisionalTabs, 6);
    assert.equal(slow.labelRequests().length, 1, 'no request without time left');
    assert.deepEqual(hiddenLocal, {});
  } finally {
    slow.restore();
  }
});

test('a cloud label failure within the deadline still falls back at once', async () => {
  const tabs = makeTopicTabs(72, 7200, { food: 3, travel: 3 });
  installBrowser(tabs);
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    async json() { return { error: { message: 'Invalid key' } }; }
  });
  try {
    const result = await executeTabGrouping(72, { provider: 'openai', openaiApiKey: 'bad' });
    assert.equal(result.source, 'offline-fallback');
    assert.equal(result.fallbackCode, 'auth');
    assert.equal(result.deadlineHit, false);
    assert.equal(result.provisionalTabs, 6);
  } finally {
    globalThis.fetch = original;
  }
});

test('a Nano click with no time left to name its groups is not reused by the exact cache', async () => {
  const tabs = makeTopicTabs(73, 7300, { food: 4, travel: 4, dev: 4 });
  const { local } = installBrowser(tabs, { sync: { provider: 'gemini_nano' } });
  // A fast estimate puts all 12 tabs in one prompt, which then leaves under 3 s.
  local.foldnex_nano_perf_v1 = { overheadMs: 200, msPerTab: 60 };
  const nano = installNanoMock({ nameFor: name => `${name} Hub`, labelDelayMs: 900 });
  const settings = { provider: 'gemini_nano' };
  try {
    const first = await executeTabGrouping(73, settings, { budgetMs: 3400 });
    assert.equal(first.source, 'nano');
    assert.equal(first.deadlineHit, false);
    assert.equal(first.provisionalTabs, 0);
    assert.equal(nano.labelPrompts.length, 1);
    assert.equal(nano.namePrompts.length, 0, 'naming was skipped for time');
    assert.deepEqual(first.groups.map(group => group.name).sort(), ['Coding', 'Food & Recipes', 'Travel']);
    assert.equal(local.foldnex_exact_results_v1, undefined, 'deterministic names are not cached');

    // The background names the groups; the next click uses those names.
    await refreshWindowPlan(73, settings);
    assert.equal(nano.namePrompts.length, 1);
    const second = await executeTabGrouping(73, settings);
    assert.equal(second.source, 'label-cache');
    assert.deepEqual(second.groups.map(group => group.name).sort(), ['Coding Hub', 'Food & Recipes Hub', 'Travel Hub']);
    assert.equal(local.foldnex_exact_results_v1.length, 1, 'a named result is cached');

    const third = await executeTabGrouping(73, settings);
    assert.equal(third.source, 'exact-cache');
    assert.deepEqual(membership(third.groups), membership(second.groups));
    assert.equal(nano.namePrompts.length, 1);
  } finally {
    removeNanoMock();
  }
});

test('an exact-cache hit takes a newer remembered name and keeps its membership', async () => {
  const tabs = makeTopicTabs(74, 7400, { food: 4, travel: 4, dev: 4 });
  const { local } = installBrowser(tabs);
  const nano = installNanoMock({ nameFor: name => `${name} Hub` });
  const settings = { provider: 'gemini_nano' };
  try {
    const first = await executeTabGrouping(74, settings);
    assert.equal(nano.namePrompts.length, 1);
    assert.equal(local.foldnex_exact_results_v1.length, 1);

    // A later naming (another click or the background) renames the food group.
    const memory = await PlanMemory.read();
    const food = memory.names.find(record => record.n === 'Food & Recipes Hub');
    assert.ok(food);
    await PlanMemory.putNames([{ ...food, n: 'Weeknight Dinners' }]);

    const prompts = nano.labelPrompts.length + nano.namePrompts.length;
    const second = await executeTabGrouping(74, settings);
    assert.equal(second.source, 'exact-cache');
    assert.equal(nano.labelPrompts.length + nano.namePrompts.length, prompts, 'no model call');
    assert.deepEqual(second.groups.map(group => group.name).sort(), ['Coding Hub', 'Travel Hub', 'Weeknight Dinners']);
    const ids = groups => groups.map(group => [...group.tabIds].sort((a, b) => a - b).join(',')).sort();
    assert.deepEqual(ids(second.groups), ids(first.groups));
    assert.equal(second.nameSources.memory, 1);

    // A remembered name another group already holds is not applied.
    const travel = (await PlanMemory.read()).names.find(record => record.n === 'Travel Hub');
    await PlanMemory.putNames([{ ...travel, n: 'Coding Hub' }]);
    const third = await executeTabGrouping(74, settings);
    assert.equal(third.source, 'exact-cache');
    assert.deepEqual(third.groups.map(group => group.name).sort(), ['Coding Hub', 'Travel Hub', 'Weeknight Dinners']);
  } finally {
    removeNanoMock();
  }
});
