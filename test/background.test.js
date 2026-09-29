import assert from 'node:assert/strict';
import test from 'node:test';

import { NAME_SYSTEM, resetNanoBases } from '../src/ai-engine.js';
import { TabLabelCache } from '../src/cache-engine.js';
import {
  autoGroupWindow,
  classifyTabs,
  createBackgroundClassifier,
  createNewTabTracker,
  isOnDeviceEngine,
  loadBackgroundScope,
  refreshAndAutoGroup
} from '../src/background-classifier.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return true;
    await sleep(10);
  }
  return false;
}

function makeArea(store) {
  return {
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
  };
}

/** Deterministic category per title, standing in for a model. */
function keyForTitle(title) {
  const text = String(title).toLowerCase();
  if (/recipe|ramen|kitchen/.test(text)) return 'food';
  if (/flight|hotel|trip/.test(text)) return 'travel';
  if (/react|rust|issue|pull request/.test(text)) return 'dev';
  return 'learn';
}

const TOPIC_TITLES = {
  food: 'Easy ramen recipe',
  travel: 'Cheap flights to Tokyo',
  dev: 'React hooks reference'
};

function makeTopicTabs(windowId, startId, counts) {
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
        url: `https://www.${topic}-site-${startId + index}.com/page/${i}`
      });
    }
  }
  return tabs;
}

/**
 * Chrome for the tabs given: storage areas, tabs filtered by window and
 * group, and tab groups. With `liveGroups`, titled groups exist while they
 * have members, as in Chrome.
 */
function installBrowser(tabs, { sync = {}, chromeGroups = [], liveGroups = false } = {}) {
  const local = {};
  const session = {};
  const calls = { group: [], update: [] };
  let nextGroupId = 3000;
  const groups = chromeGroups.map(group => ({ ...group }));
  globalThis.chrome = {
    storage: {
      local: makeArea(local),
      session: makeArea(session),
      sync: makeArea(sync)
    },
    tabs: {
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
      async group(details) {
        calls.group.push(JSON.parse(JSON.stringify(details)));
        const groupId = details.groupId ?? nextGroupId++;
        for (const id of details.tabIds) {
          const tab = tabs.find(item => item.id === id);
          if (tab) tab.groupId = groupId;
        }
        return groupId;
      },
      async ungroup(ids) {
        for (const id of [].concat(ids)) {
          const tab = tabs.find(item => item.id === id);
          if (tab) tab.groupId = -1;
        }
      },
      async remove() {}
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      async query(query = {}) {
        return groups
          .filter(group => query.windowId === undefined || group.windowId === query.windowId)
          .filter(group => !liveGroups || tabs.some(tab => tab.groupId === group.id))
          .map(group => ({ ...group }));
      },
      async update(id, details) {
        calls.update.push({ id, ...details });
        const group = groups.find(item => item.id === id);
        if (group) Object.assign(group, details);
        else groups.push({ id, windowId: tabs.find(tab => tab.groupId === id)?.windowId, ...details });
      }
    }
  };
  return { local, session, sync, calls, groups };
}

function installNanoMock({ labelFor = keyForTitle, nameFor = name => name } = {}) {
  const calls = { labelPrompts: [], namePrompts: [] };
  const makeSession = createOptions => ({
    inputUsage: 300,
    async clone() {
      return makeSession(createOptions);
    },
    async prompt(text) {
      const naming = createOptions?.initialPrompts?.[0]?.content === NAME_SYSTEM;
      (naming ? calls.namePrompts : calls.labelPrompts).push(text);
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
    async availability() { return 'available'; },
    async create(options) { return makeSession(options); }
  };
  return calls;
}

function removeNanoMock() {
  resetNanoBases();
  delete globalThis.LanguageModel;
  delete globalThis.self;
}

/** An OpenAI-compatible endpoint that labels every row and tracks concurrency. */
function installCloudFetch({ delayMs = 0 } = {}) {
  const original = globalThis.fetch;
  const requests = [];
  let inFlight = 0;
  let peak = 0;
  globalThis.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    const content = payload.messages.at(-1).content;
    const rows = content.includes('{"tabs":')
      ? JSON.parse(content.slice(content.lastIndexOf('{"tabs":'))).tabs
      : [];
    requests.push({ url, rows });
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      if (delayMs > 0) await sleep(delayMs);
    } finally {
      inFlight--;
    }
    const answer = Object.fromEntries(rows.map(([id, title]) => [String(id), keyForTitle(title)]));
    return {
      ok: true,
      async json() {
        return { model: payload.model, choices: [{ message: { content: JSON.stringify(answer) } }], usage: null };
      }
    };
  };
  return {
    requests,
    peak: () => peak,
    titles: () => requests.flatMap(request => request.rows.map(row => row[1])),
    restore() { globalThis.fetch = original; }
  };
}

async function cacheLabels(tabs, engine = 'gemini_nano') {
  const { fingerprintById } = await TabLabelCache.lookup(tabs);
  await TabLabelCache.store(new Map(tabs.map(tab => [tab.id, keyForTitle(tab.title)])), fingerprintById, engine);
}

const ON_DEVICE = async () => ({ allowed: true, onDevice: true, autoGroup: true });

/* ------------------------------------------------------------------------ */
/* Auto-group resolves plan groups by membership                            */
/* ------------------------------------------------------------------------ */

test('auto-group joins the Chrome group holding a plan group\'s members, whatever its title', async () => {
  const W = 201;
  const tabs = makeTopicTabs(W, 20100, { travel: 3, food: 2 });
  for (const tab of tabs) tab.groupId = tab.title.includes('flights') ? 11 : 12;
  const newcomer = { ...makeTopicTabs(W, 20190, { travel: 1 })[0], index: tabs.length };
  tabs.push(newcomer);
  const { calls } = installBrowser(tabs, {
    chromeGroups: [
      { id: 11, windowId: W, title: 'Travel' },
      { id: 12, windowId: W, title: 'Food & Recipes' },
      { id: 13, windowId: W, title: 'Japan Trip' }
    ]
  });
  const plan = {
    groups: [
      { name: 'Japan Trip', kind: 'category', tabIds: [20100, 20101, 20102, 20190] },
      { name: 'Home Cooking', kind: 'category', tabIds: [20103, 20104] }
    ]
  };

  // One new tab joins at once; the empty same-titled group is not used.
  assert.equal(await autoGroupWindow(W, plan, { candidateIds: [20190] }), 1);
  assert.deepEqual(calls.group, [{ groupId: 11, tabIds: [20190] }]);
  assert.deepEqual(calls.update, []);
});

test('auto-group never creates a second group for members that already sit in one', async () => {
  const W = 202;
  const tabs = makeTopicTabs(W, 20200, { travel: 7 });
  // Members sit 2:1 across two groups, and one more in Review Later, which never counts.
  tabs[0].groupId = 21;
  tabs[1].groupId = 21;
  tabs[2].groupId = 22;
  tabs[3].groupId = 23;
  const newIds = [20204, 20205, 20206];
  const { calls } = installBrowser(tabs, {
    chromeGroups: [
      { id: 21, windowId: W, title: 'Travel' },
      { id: 22, windowId: W, title: 'Trips' },
      { id: 23, windowId: W, title: 'Review Later' }
    ]
  });
  const plan = { groups: [{ name: 'Tokyo', kind: 'category', tabIds: tabs.map(tab => tab.id) }] };
  assert.equal(await autoGroupWindow(W, plan, { candidateIds: newIds }), 3);
  assert.deepEqual(calls.group, [{ groupId: 21, tabIds: newIds }]);
});

test('auto-group falls back to a title match only when no member is grouped', async () => {
  const W = 203;
  const tabs = makeTopicTabs(W, 20300, { food: 2, travel: 2 });
  tabs[0].groupId = 31;
  const { calls } = installBrowser(tabs, { chromeGroups: [{ id: 31, windowId: W, title: 'Travel' }] });
  // Food members are ungrouped, but a group titled Travel exists for the travel plan group.
  const plan = {
    groups: [
      { name: 'Travel', kind: 'category', tabIds: [20302, 20303] },
      { name: 'Food & Recipes', kind: 'category', tabIds: [20300, 20301] }
    ]
  };
  await autoGroupWindow(W, plan, { candidateIds: [20301, 20302, 20303] });
  // Travel joins by title; the one ungrouped food tab joins the group its sibling sits in.
  assert.deepEqual(calls.group, [
    { groupId: 31, tabIds: [20302, 20303] },
    { groupId: 31, tabIds: [20301] }
  ]);
});

test('background naming that renames only the stored plan no longer splits a topic', async () => {
  const W = 204;
  const tabs = makeTopicTabs(W, 20400, { travel: 4, food: 4, dev: 4 });
  const idOf = { travel: 41, food: 42, dev: 43 };
  for (const tab of tabs) tab.groupId = idOf[keyForTitle(tab.title)];
  const newcomers = makeTopicTabs(W, 20490, { travel: 2 }).map((tab, i) => ({ ...tab, index: 12 + i, title: `Hotel near Tokyo station ${i}` }));
  tabs.push(...newcomers);
  const { calls } = installBrowser(tabs, {
    sync: { provider: 'gemini_nano', autoGroupNewTabs: true },
    chromeGroups: [
      { id: 41, windowId: W, title: 'Travel' },
      { id: 42, windowId: W, title: 'Food & Recipes' },
      { id: 43, windowId: W, title: 'Coding' }
    ]
  });
  await cacheLabels(tabs);
  const renamed = { Travel: 'Japan Trip', 'Food & Recipes': 'Home Cooking', Coding: 'React App' };
  const nano = installNanoMock({ nameFor: name => renamed[name] || name });
  try {
    const plan = await refreshAndAutoGroup(W, null, { candidateIds: newcomers.map(tab => tab.id) });
    assert.equal(nano.namePrompts.length, 1);
    assert.ok(plan.groups.some(group => group.name === 'Japan Trip'), 'the stored plan was renamed');
    assert.deepEqual(calls.group, [{ groupId: 41, tabIds: [20490, 20491] }]);
  } finally {
    removeNanoMock();
  }
});

/* ------------------------------------------------------------------------ */
/* Auto-group candidates                                                    */
/* ------------------------------------------------------------------------ */

function recordingClassifier({ stored = () => [], tracker = createNewTabTracker(), ...options } = {}) {
  const refreshes = [];
  const classified = [];
  const classifier = createBackgroundClassifier({
    classify: async ids => {
      classified.push(ids);
      return { windowIds: [], storedWindowIds: stored(ids), labelledIds: [], unlabelledIds: [] };
    },
    refresh: async (windowId, _signal, details) => {
      refreshes.push({ windowId, ...details });
      return null;
    },
    scope: ON_DEVICE,
    tracker,
    flushDelayMs: 5,
    refreshDelayMs: 5,
    ...options
  });
  return { classifier, refreshes, classified, tracker };
}

test('popup open, a cleanup and a cached-only flush never auto-group', async () => {
  const W = 205;
  const tabs = makeTopicTabs(W, 20500, { food: 3 });
  installBrowser(tabs);
  let stored = [];
  const { classifier, refreshes, classified, tracker } = recordingClassifier({ stored: () => stored });
  try {
    // A candidate exists in the window, but only its own load may trigger auto-group.
    await tracker.markNew(20500);

    await classifier.prioritize(W);
    assert.ok(await waitFor(() => classified.length === 1));
    await sleep(40);
    assert.deepEqual(refreshes, [], 'nothing stored, nothing refreshed');

    stored = [W];
    classifier.enqueue([20501], { reason: 'title' });
    assert.ok(await waitFor(() => refreshes.length === 1));
    assert.equal(refreshes[0].autoGroup, false);
    assert.deepEqual(refreshes[0].candidateIds, []);

    classifier.scheduleWindowPlanRefresh(W);
    assert.ok(await waitFor(() => refreshes.length === 2));
    assert.equal(refreshes[1].autoGroup, false);
  } finally {
    classifier.pause();
  }
});

test('only a tab opened or navigated with Auto-group on becomes a candidate, until it is grouped or taken out', async () => {
  const W = 206;
  const tabs = makeTopicTabs(W, 20600, { food: 4 });
  installBrowser(tabs);
  const { classifier, refreshes, tracker } = recordingClassifier();
  const on = { autoGroup: true };
  const [a, b, c, d] = tabs;
  try {
    // Opened while Auto-group was on, then loaded: its window auto-groups it.
    await classifier.noteTabCreated({ ...a, status: 'loading', url: '', pendingUrl: a.url }, on);
    await classifier.noteTabUpdated(a.id, { status: 'complete' }, a, on);
    assert.ok(await waitFor(() => refreshes.length === 1));
    assert.equal(refreshes[0].autoGroup, true);
    assert.deepEqual(refreshes[0].candidateIds, [a.id]);

    // Grouped, then taken out by the user: no longer a candidate.
    await classifier.noteTabUpdated(a.id, { groupId: 7 }, { ...a, groupId: 7 }, on);
    assert.deepEqual(await tracker.candidateIds(), []);
    await tracker.markNew(a.id);
    await classifier.noteTabUpdated(a.id, { groupId: -1 }, a, on);
    assert.deepEqual(await tracker.candidateIds(), []);

    // A fragment change is not a new page; an old tab's reload or title change is not new either.
    await classifier.noteTabUpdated(a.id, { url: `${a.url}#comments` }, { ...a, url: `${a.url}#comments` }, on);
    await classifier.noteTabUpdated(b.id, { status: 'complete' }, b, on);
    await classifier.noteTabUpdated(c.id, { title: 'Kitchen notes' }, { ...c, title: 'Kitchen notes' }, on);
    await classifier.noteTabUpdated(c.id, { url: 'https://www.food-site-20602.com/other' }, { ...c, url: 'https://www.food-site-20602.com/other' }, on);
    await sleep(60);
    assert.equal(refreshes.length, 1);
    assert.deepEqual(await tracker.candidateIds(), []);

    // Opening a new page makes the taken-out tab a candidate again.
    const next = 'https://www.food-site-20600.com/another';
    await classifier.noteTabUpdated(a.id, { status: 'loading', url: next }, { ...a, status: 'loading', url: next }, on);
    await classifier.noteTabUpdated(a.id, { status: 'complete' }, { ...a, url: next }, on);
    assert.ok(await waitFor(() => refreshes.length === 2));
    assert.equal(refreshes[1].autoGroup, true);
    assert.deepEqual(refreshes[1].candidateIds, [a.id]);

    // Ungroup all: the window's tabs stop being candidates.
    await classifier.noteWindowUngrouped(W);
    assert.deepEqual(await tracker.candidateIds(), []);

    // Opened while Auto-group was off: not a candidate.
    await classifier.noteTabCreated({ ...d, status: 'loading' }, { autoGroup: false });
    await classifier.noteTabUpdated(d.id, { status: 'complete' }, d, { autoGroup: false });
    await sleep(60);
    assert.equal(refreshes.length, 2);

    // Turning Auto-group off forgets new tabs; closing a tab forgets it.
    await classifier.noteTabCreated({ ...d, id: 20699, status: 'loading' }, on);
    await classifier.noteTabCreated({ ...d, id: 20698, status: 'loading' }, on);
    await classifier.noteTabRemoved(20698);
    assert.deepEqual(await tracker.candidateIds(), [20699]);
    await classifier.setAutoGroup(false);
    assert.deepEqual(await tracker.candidateIds(), []);
    assert.deepEqual(await tracker.freshIds(), []);
  } finally {
    classifier.pause();
  }
});

test('an address the page rewrites itself is not a new page and is re-labelled like a title change', async () => {
  const W = 223;
  const maps = {
    id: 22300, windowId: W, index: 0, pinned: false, incognito: false, status: 'complete', groupId: -1,
    title: 'Google Maps', url: 'https://www.google.com/maps/@51.50,-0.12,15z'
  };
  const other = { ...makeTopicTabs(W, 22301, { travel: 1 })[0], index: 1 };
  installBrowser([maps, other], { sync: { provider: 'openai', openaiApiKey: 'test-only', autoGroupNewTabs: true } });
  const cloud = installCloudFetch();
  const tracker = createNewTabTracker();
  const cloudQueue = createBackgroundClassifier({ tracker, flushDelayMs: 20, flushMaxWaitMs: 60, refreshDelayMs: 60000 });
  const classified = [];
  const localQueue = createBackgroundClassifier({
    classify: async ids => {
      classified.push(ids);
      return { windowIds: [W], storedWindowIds: [], labelledIds: ids, unlabelledIds: [] };
    },
    refresh: async () => null,
    scope: ON_DEVICE,
    tracker: createNewTabTracker(),
    flushDelayMs: 20,
    flushMaxWaitMs: 60
  });
  const on = { autoGroup: true };
  try {
    // An old map tab the user took out of a group, panned eight times.
    await cloudQueue.noteTabUpdated(maps.id, { groupId: -1 }, maps, on);
    for (let i = 1; i <= 8; i++) {
      maps.url = `https://www.google.com/maps/@51.${50 + i},-0.12,15z`;
      // Chrome may or may not report the status with a same-document change.
      const changeInfo = i % 2 ? { url: maps.url } : { status: 'complete', url: maps.url };
      await cloudQueue.noteTabUpdated(maps.id, changeInfo, { ...maps }, on);
      await localQueue.noteTabUpdated(maps.id, changeInfo, { ...maps }, on);
      await sleep(40);
    }
    await sleep(100);
    assert.deepEqual(await tracker.candidateIds(), [], 'a taken-out tab stays out');
    assert.deepEqual(await tracker.freshIds(), [], 'an old tab does not become new');
    assert.equal(cloud.requests.length, 0);
    assert.equal(classified.length, 1, 'an on-device engine re-labels it once per interval');
  } finally {
    cloudQueue.pause();
    localQueue.pause();
    cloud.restore();
  }
});

test('the new-tab tracker survives a service-worker restart through session storage', async () => {
  const store = {};
  const first = createNewTabTracker({ area: () => makeArea(store) });
  await first.markNew(1);
  await first.markNew(2, { grouped: true });
  await first.markTakenOut([[3, 'key-3']]);
  await first.flushed();

  const second = createNewTabTracker({ area: () => makeArea(store) });
  assert.deepEqual(await second.candidateIds(), [1]);
  assert.deepEqual((await second.freshIds()).sort(), [1, 2]);
  assert.equal(await second.outKey(3), 'key-3');
});

test('after Ungroup all, opening the popup regroups nothing and a removed tab stays out', async () => {
  const W = 207;
  const tabs = makeTopicTabs(W, 20700, { food: 5, travel: 5, dev: 5 });
  const { calls } = installBrowser(tabs, {
    sync: { provider: 'gemini_nano', groupingStrategy: 'task', autoGroupNewTabs: true },
    chromeGroups: [{ id: 71, windowId: W, title: 'Food & Recipes' }],
    liveGroups: true
  });
  await cacheLabels(tabs);
  installNanoMock();
  const classifier = createBackgroundClassifier({ flushDelayMs: 10, refreshDelayMs: 20 });
  const on = { autoGroup: true };
  try {
    // Every tab is ungrouped, as Ungroup all leaves them.
    await classifier.prioritize(W);
    await sleep(250);
    assert.deepEqual(calls.group, []);

    // The food tabs are grouped again; the user takes one out.
    const food = tabs.filter(tab => keyForTitle(tab.title) === 'food');
    for (const tab of food) tab.groupId = 71;
    const removed = food[0];
    removed.groupId = -1;
    await classifier.noteTabUpdated(removed.id, { groupId: -1 }, removed, on);

    // A new food tab loads: it joins the food group, the removed tab does not.
    const fresh = { ...makeTopicTabs(W, 20790, { food: 1 })[0], index: tabs.length, title: 'Kitchen recipe 9', status: 'loading' };
    tabs.push(fresh);
    await classifier.noteTabCreated(fresh, on);
    fresh.status = 'complete';
    await classifier.noteTabUpdated(fresh.id, { status: 'complete' }, fresh, on);
    assert.ok(await waitFor(() => calls.group.length > 0, 2000));
    await sleep(50);
    assert.deepEqual(calls.group, [{ groupId: 71, tabIds: [fresh.id] }]);
    assert.equal(removed.groupId, -1);
  } finally {
    classifier.pause();
    removeNanoMock();
  }
});

/* ------------------------------------------------------------------------ */
/* Queue timing, rate limit and retries                                     */
/* ------------------------------------------------------------------------ */

test('a tab that keeps changing cannot hold the flush past its maximum wait', async () => {
  installBrowser([]);
  const { classifier, classified } = recordingClassifier({ flushDelayMs: 50, flushMaxWaitMs: 150 });
  try {
    const startedAt = Date.now();
    let firstAt = null;
    while (Date.now() - startedAt < 400) {
      classifier.enqueue([1], { reason: 'load' });
      if (classified.length > 0 && firstAt === null) firstAt = Date.now() - startedAt;
      await sleep(15);
    }
    assert.ok(classified.length >= 2, `flushed ${classified.length} times`);
    assert.ok(firstAt !== null && firstAt < 300, `first flush after ${firstAt} ms`);
  } finally {
    classifier.pause();
  }
});

test('a refresh waits for stored labels and is never postponed past its cap', async () => {
  const W = 208;
  installBrowser(makeTopicTabs(W, 20800, { food: 2 }));
  let stored = [];
  const { classifier, refreshes, classified } = recordingClassifier({
    stored: () => stored,
    flushDelayMs: 10,
    flushMaxWaitMs: 20,
    refreshDelayMs: 100,
    refreshMaxPostponeMs: 250
  });
  try {
    // Cached-only flushes push nothing.
    classifier.enqueue([20800], { reason: 'load' });
    assert.ok(await waitFor(() => classified.length === 1));
    await sleep(150);
    assert.equal(refreshes.length, 0);

    // A label stored every ~30 ms would push the refresh forever without the cap.
    stored = [W];
    const startedAt = Date.now();
    while (refreshes.length === 0 && Date.now() - startedAt < 1500) {
      classifier.enqueue([20800], { reason: 'load' });
      await sleep(30);
    }
    const elapsed = Date.now() - startedAt;
    assert.equal(refreshes.length, 1);
    assert.ok(elapsed < 600, `refreshed after ${elapsed} ms`);
  } finally {
    classifier.pause();
  }
});

test('a title-only change re-labels a tab at most once per interval until it navigates', async () => {
  const W = 209;
  const tabs = makeTopicTabs(W, 20900, { food: 1 });
  installBrowser(tabs);
  const classified = [];
  const classifier = createBackgroundClassifier({
    classify: async ids => {
      classified.push(ids);
      return { windowIds: [W], storedWindowIds: [], labelledIds: ids, unlabelledIds: [] };
    },
    refresh: async () => null,
    scope: ON_DEVICE,
    tracker: createNewTabTracker(),
    flushDelayMs: 5,
    navigationSettleMs: 0
  });
  const tab = tabs[0];
  try {
    await classifier.noteTabUpdated(tab.id, { title: 'BTC 61,000' }, tab);
    assert.ok(await waitFor(() => classified.length === 1));
    for (let i = 0; i < 5; i++) await classifier.noteTabUpdated(tab.id, { title: `BTC 61,00${i}` }, tab);
    assert.deepEqual(classifier.pendingTabIds(), []);

    const next = 'https://www.food-site-20900.com/next';
    await classifier.noteTabUpdated(tab.id, { status: 'loading', url: next }, { ...tab, status: 'loading', url: next });
    await classifier.noteTabUpdated(tab.id, { title: 'Another page' }, { ...tab, url: next });
    assert.deepEqual(classifier.pendingTabIds(), [tab.id]);
    assert.ok(await waitFor(() => classified.length === 2));
  } finally {
    classifier.pause();
  }
});

test('a failed flush re-queues its tabs with back-off and gives up after four attempts until a new page', async () => {
  installBrowser(makeTopicTabs(210, 21000, { food: 2 }));
  const attempts = [];
  const classifier = createBackgroundClassifier({
    classify: async ids => {
      attempts.push({ ids, at: Date.now() });
      throw new Error('HTTP 429');
    },
    refresh: async () => null,
    scope: ON_DEVICE,
    tracker: createNewTabTracker(),
    flushDelayMs: 5,
    retryDelaysMs: [20, 60, 100]
  });
  try {
    classifier.enqueue([21000, 21001]);
    assert.ok(await waitFor(() => attempts.length === 4, 2000));
    await sleep(200);
    assert.equal(attempts.length, 4);
    for (const attempt of attempts) assert.deepEqual(attempt.ids, [21000, 21001]);
    const gaps = attempts.slice(1).map((attempt, i) => attempt.at - attempts[i].at);
    assert.ok(gaps[0] >= 15 && gaps[1] >= 50 && gaps[2] >= 90, `gaps ${gaps}`);

    // Given up: other queueing is ignored until the tab opens a new page.
    classifier.enqueue([21000, 21001]);
    assert.deepEqual(classifier.pendingTabIds(), []);
    const next = 'https://www.food-site-21000.com/next';
    await classifier.noteTabUpdated(21000, { status: 'loading', url: next }, { id: 21000, status: 'loading', url: next, groupId: -1 });
    classifier.enqueue([21000, 21001]);
    assert.deepEqual(classifier.pendingTabIds(), [21000]);
  } finally {
    classifier.pause();
  }
});

test('a given-up tab gets one more attempt when the popup opens or a cleanup places it provisionally', async () => {
  const W = 222;
  const tabs = makeTopicTabs(W, 22200, { food: 2 });
  installBrowser(tabs, { sync: { provider: 'gemini_nano' } });
  let availability = 'downloading';
  const nano = installNanoMock();
  globalThis.LanguageModel.availability = async () => availability;
  const ids = tabs.map(tab => tab.id);
  const classifier = createBackgroundClassifier({
    refresh: async () => null,
    tracker: createNewTabTracker(),
    flushDelayMs: 5,
    retryDelaysMs: [10, 10, 10]
  });
  const settled = () => classifier.pendingTabIds().length === 0;
  try {
    // The model is still downloading: four attempts, then the tabs give up.
    classifier.enqueue(ids);
    await sleep(250);
    classifier.enqueue(ids);
    assert.deepEqual(classifier.pendingTabIds(), [], 'given up');

    // Still failing: a cleanup's provisional tabs try once and give up again at once.
    classifier.enqueue(ids, { retryGivenUp: true });
    assert.deepEqual(classifier.pendingTabIds(), ids);
    assert.ok(await waitFor(settled));
    await sleep(60);
    classifier.enqueue(ids);
    assert.deepEqual(classifier.pendingTabIds(), [], 'given up after one more attempt');

    // Once the model is ready, opening the popup labels them.
    availability = 'available';
    resetNanoBases();
    await classifier.prioritize(W);
    assert.deepEqual(classifier.pendingTabIds(), ids);
    assert.ok(await waitFor(async () => (await TabLabelCache.lookup(tabs)).missing.length === 0, 2000));
    assert.ok(nano.labelPrompts.length > 0);
  } finally {
    classifier.pause();
    removeNanoMock();
  }
});

test('a partial result re-queues only the unlabelled tabs, from the result or the thrown error', async () => {
  installBrowser(makeTopicTabs(211, 21100, { food: 3 }));
  const seen = [];
  let round = 0;
  const classifier = createBackgroundClassifier({
    classify: async ids => {
      seen.push(ids);
      round++;
      if (round === 1) {
        return { windowIds: [211], storedWindowIds: [], labelledIds: [21100], unlabelledIds: [21101, 21102], error: new Error('batch failed') };
      }
      if (round === 2) throw Object.assign(new Error('timeout'), { unlabelledIds: [21102] });
      return { windowIds: [211], storedWindowIds: [], labelledIds: ids, unlabelledIds: [] };
    },
    refresh: async () => null,
    scope: ON_DEVICE,
    tracker: createNewTabTracker(),
    flushDelayMs: 5,
    retryDelaysMs: [20, 20, 20]
  });
  try {
    classifier.enqueue([21100, 21101, 21102]);
    assert.ok(await waitFor(() => seen.length === 3, 2000));
    assert.deepEqual(seen, [[21100, 21101, 21102], [21101, 21102], [21102]]);
    await sleep(80);
    assert.equal(seen.length, 3);
  } finally {
    classifier.pause();
  }
});

test('a Nano batch that fails mid-run is retried until every tab is labelled', async () => {
  const W = 212;
  const tabs = makeTopicTabs(W, 21200, { food: 14, travel: 14, dev: 12 });
  installBrowser(tabs, { sync: { provider: 'gemini_nano' } });
  let failed = false;
  const nano = installNanoMock({
    labelFor: title => {
      if (!failed && title.includes('Tokyo 5')) {
        failed = true;
        throw new Error('UnknownError');
      }
      return keyForTitle(title);
    }
  });
  const classifier = createBackgroundClassifier({ refresh: async () => null, flushDelayMs: 5, retryDelaysMs: [30, 30, 30] });
  try {
    classifier.enqueue(tabs.map(tab => tab.id));
    assert.ok(await waitFor(async () => (await TabLabelCache.lookup(tabs)).missing.length === 0, 3000));
    assert.ok(failed);
    assert.ok(nano.labelPrompts.length > 3, `${nano.labelPrompts.length} prompts`);
  } finally {
    classifier.pause();
    removeNanoMock();
  }
});

/* ------------------------------------------------------------------------ */
/* What the background may label                                            */
/* ------------------------------------------------------------------------ */

test('classifyTabs labels discarded and unloaded tabs and skips loading ones', async () => {
  const W = 213;
  const tabs = makeTopicTabs(W, 21300, { food: 3, travel: 3 });
  tabs[0].status = 'unloaded';
  tabs[1].status = 'unloaded';
  tabs[1].discarded = true;
  tabs[2].status = 'loading';
  installBrowser(tabs, { sync: { provider: 'gemini_nano' } });
  const nano = installNanoMock();
  try {
    const result = await classifyTabs(tabs.map(tab => tab.id));
    assert.deepEqual(result.windowIds, [W]);
    assert.deepEqual(result.storedWindowIds, [W]);
    assert.deepEqual([...result.labelledIds].sort((a, b) => a - b), [21300, 21301, 21303, 21304, 21305]);
    assert.ok(nano.labelPrompts.every(text => !text.includes('recipe 2')));
  } finally {
    removeNanoMock();
  }
});

test('background cloud labelling sends one batch at a time', async () => {
  const W = 214;
  const tabs = makeTopicTabs(W, 21400, { food: 20, travel: 20, dev: 20 });
  installBrowser(tabs, { sync: { provider: 'openai', openaiApiKey: 'test-only', autoGroupNewTabs: true } });
  const cloud = installCloudFetch({ delayMs: 20 });
  try {
    const result = await classifyTabs(tabs.map(tab => tab.id));
    assert.equal(cloud.requests.length, 3);
    assert.equal(cloud.peak(), 1);
    assert.equal(result.labelledIds.length, 60);
  } finally {
    cloud.restore();
  }
});

test('only Nano and Ollama on a loopback address count as on-device', async () => {
  assert.equal(isOnDeviceEngine({}), true);
  assert.equal(isOnDeviceEngine({ provider: 'gemini_nano' }), true);
  assert.equal(isOnDeviceEngine({ provider: 'ollama' }), true);
  for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:11434/v1', 'http://[::1]:11434/v1']) {
    assert.equal(isOnDeviceEngine({ provider: 'ollama', ollamaBaseUrl: url }), true, url);
  }
  assert.equal(isOnDeviceEngine({ provider: 'ollama', ollamaBaseUrl: 'https://ollama.example.com/v1' }), false);
  assert.equal(isOnDeviceEngine({ provider: 'ollama', ollamaBaseUrl: 'http://localhost.example.com/v1' }), false);
  assert.equal(isOnDeviceEngine({ provider: 'openai' }), false);
  assert.equal(isOnDeviceEngine({ provider: 'offline' }), false);

  assert.deepEqual(await loadBackgroundScope({ provider: 'openai' }), { allowed: false, onDevice: false, autoGroup: false });
  assert.deepEqual(await loadBackgroundScope({ provider: 'openai', autoGroupNewTabs: true }), { allowed: true, onDevice: false, autoGroup: true });
  assert.deepEqual(await loadBackgroundScope({ provider: 'ollama', ollamaBaseUrl: 'https://ollama.example.com/v1' }), { allowed: false, onDevice: false, autoGroup: false });
  assert.deepEqual(await loadBackgroundScope({ provider: 'ollama' }), { allowed: true, onDevice: true, autoGroup: false });
  assert.equal((await loadBackgroundScope({ provider: 'gemini_nano', groupingStrategy: 'site' })).allowed, false);
});

test('a cloud engine only receives pages opened after Auto-group was on, never title-only changes', async () => {
  const W = 215;
  const tabs = makeTopicTabs(W, 21500, { food: 3, travel: 3 });
  installBrowser(tabs, { sync: { provider: 'openai', openaiApiKey: 'test-only', autoGroupNewTabs: true } });
  const cloud = installCloudFetch();
  const classifier = createBackgroundClassifier({ flushDelayMs: 40, refreshDelayMs: 60000, navigationSettleMs: 0 });
  const on = { autoGroup: true };
  try {
    // Tabs that were already open: popup open, a startup queue, a cleanup's provisional tabs, title changes.
    await classifier.prioritize(W);
    classifier.enqueue(tabs.map(tab => tab.id));
    for (const tab of tabs) {
      await classifier.noteTabUpdated(tab.id, { title: `${tab.title} (1)` }, tab, on);
      await classifier.noteTabUpdated(tab.id, { status: 'complete' }, tab, on);
    }
    await sleep(120);
    assert.equal(cloud.requests.length, 0);

    // Two tabs opened afterwards are sent, and only they.
    const fresh = makeTopicTabs(W, 21590, { dev: 2 }).map((tab, i) => ({ ...tab, index: tabs.length + i }));
    tabs.push(...fresh);
    for (const tab of fresh) await classifier.noteTabCreated({ ...tab, status: 'loading' }, on);
    for (const tab of fresh) await classifier.noteTabUpdated(tab.id, { status: 'complete' }, tab, on);
    assert.ok(await waitFor(() => cloud.requests.length === 1));
    assert.deepEqual(cloud.titles().sort(), fresh.map(tab => tab.title).sort());

    // A later title-only change on a new tab is not sent.
    fresh[0].title = 'React hooks reference, edited';
    await classifier.noteTabUpdated(fresh[0].id, { title: fresh[0].title }, fresh[0], on);
    await sleep(120);
    assert.equal(cloud.requests.length, 1);
  } finally {
    classifier.pause();
    cloud.restore();
  }
});

test('an Ollama server off this device is treated like a cloud engine', async () => {
  const W = 216;
  const tabs = makeTopicTabs(W, 21600, { food: 3 });
  const remote = { provider: 'ollama', ollamaBaseUrl: 'https://ollama.example.com/v1' };
  installBrowser(tabs, { sync: { ...remote } });
  const cloud = installCloudFetch();
  try {
    const classifier = createBackgroundClassifier({ flushDelayMs: 10, refreshDelayMs: 60000 });
    await classifier.prioritize(W);
    await sleep(80);
    classifier.pause();
    assert.equal(cloud.requests.length, 0, 'no consent without Auto-group');

    installBrowser(tabs, { sync: { ...remote, autoGroupNewTabs: true } });
    const consented = createBackgroundClassifier({ flushDelayMs: 10, refreshDelayMs: 60000 });
    await consented.prioritize(W);
    await sleep(80);
    consented.pause();
    assert.equal(cloud.requests.length, 0, 'tabs already open are not sent');
  } finally {
    cloud.restore();
  }
});

/* ------------------------------------------------------------------------ */
/* Pause                                                                    */
/* ------------------------------------------------------------------------ */

test('an abort stops auto-group before its next Chrome change, and a group it just made keeps its title', async () => {
  const W = 217;
  const tabs = makeTopicTabs(W, 21700, { food: 2, travel: 2, dev: 2 });
  const { calls } = installBrowser(tabs);
  const group = chrome.tabs.group;
  chrome.tabs.group = async details => {
    const id = await group(details);
    await sleep(30);
    return id;
  };
  const plan = {
    groups: [
      { name: 'Food & Recipes', tabIds: [21700, 21701] },
      { name: 'Travel', tabIds: [21702, 21703] },
      { name: 'Coding', tabIds: [21704, 21705] }
    ]
  };
  const controller = new AbortController();
  const run = autoGroupWindow(W, plan, { signal: controller.signal });
  assert.ok(await waitFor(() => calls.group.length === 1, 1000));
  controller.abort(new Error('Paused for cleanup'));
  await assert.rejects(run, /Paused for cleanup/);
  await sleep(60);
  assert.equal(calls.group.length, 1);
  // The group created as the pause arrived is not left unnamed.
  assert.deepEqual(calls.update.map(update => [update.id, update.title]), [[3000, 'Food & Recipes']]);
});

test('auto-group re-reads each tab and never moves one grouped meanwhile', async () => {
  const W = 218;
  const tabs = makeTopicTabs(W, 21800, { food: 2, travel: 2 });
  const { calls } = installBrowser(tabs, { chromeGroups: [{ id: 81, windowId: W, title: 'Travel' }] });
  const group = chrome.tabs.group;
  chrome.tabs.group = async details => {
    const id = await group(details);
    // A cleanup takes a travel tab while the auto-group runs.
    const taken = tabs.find(tab => tab.id === 21802);
    if (taken.groupId === -1) taken.groupId = 999;
    return id;
  };
  const plan = {
    groups: [
      { name: 'Food & Recipes', tabIds: [21800, 21801] },
      { name: 'Travel', tabIds: [21802, 21803] }
    ]
  };
  await autoGroupWindow(W, plan);
  assert.equal(calls.group.length, 2);
  assert.deepEqual(calls.group[1], { groupId: 81, tabIds: [21803] });
  assert.equal(tabs.find(tab => tab.id === 21802).groupId, 999);
});

test('pause aborts a running plan refresh, and nested pauses hold until the last resume', async () => {
  const W = 219;
  installBrowser(makeTopicTabs(W, 21900, { food: 2 }));
  const signals = [];
  const classifier = createBackgroundClassifier({
    classify: async () => ({ windowIds: [], storedWindowIds: [], labelledIds: [], unlabelledIds: [] }),
    refresh: async (_windowId, signal) => {
      signals.push(signal);
      await sleep(40);
      signal.throwIfAborted();
    },
    scope: ON_DEVICE,
    tracker: createNewTabTracker(),
    flushDelayMs: 5,
    refreshDelayMs: 5
  });
  try {
    classifier.scheduleWindowPlanRefresh(W);
    assert.ok(await waitFor(() => signals.length === 1));
    classifier.pause();
    classifier.pause();
    assert.equal(signals[0].aborted, true);
    await classifier.whenIdle();
    classifier.resume();
    await sleep(60);
    assert.equal(signals.length, 1, 'still paused');
    classifier.resume();
    assert.ok(await waitFor(() => signals.length === 2), 'the aborted refresh runs again');
  } finally {
    classifier.pause();
  }
});

/* ------------------------------------------------------------------------ */
/* Service worker wiring                                                    */
/* ------------------------------------------------------------------------ */

/** The service worker's event sources on the installed Chrome mock; returns the listeners it registers. */
function installWorkerEvents() {
  const listeners = {};
  const event = name => ({ addListener(listener) { listeners[name] = listener; } });
  chrome.storage.local.setAccessLevel = async () => {};
  chrome.storage.onChanged = event('storageChanged');
  chrome.action = { onClicked: event('actionClicked'), async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setPopup() {} };
  chrome.commands = { onCommand: event('command') };
  chrome.runtime = { onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message'), openOptionsPage() {} };
  chrome.tabs.onCreated = event('tabCreated');
  chrome.tabs.onUpdated = event('tabUpdated');
  chrome.tabs.onRemoved = event('tabRemoved');
  chrome.tabGroups.onUpdated = event('groupUpdated');
  chrome.tabGroups.onRemoved = event('groupRemoved');
  chrome.windows = { onRemoved: event('windowRemoved') };
  chrome.management = { async getSelf() { return { installType: 'normal' }; } };
  return listeners;
}

test('the first worker run of a browser session treats early tab events as restored tabs', async () => {
  const W = 221;
  const tabs = makeTopicTabs(W, 22100, { food: 2 });
  const { session } = installBrowser(tabs, { sync: { provider: 'openai', openaiApiKey: 'test-only', autoGroupNewTabs: true } });
  const listeners = installWorkerEvents();
  const cloud = installCloudFetch();
  try {
    await import('../background.js?first-run-of-session');
    // A restored tab's events reach the worker before onStartup does.
    const restored = { ...makeTopicTabs(W, 22190, { dev: 1 })[0], index: tabs.length };
    tabs.push(restored);
    await listeners.tabCreated({ ...restored, status: 'loading' });
    await listeners.tabUpdated(restored.id, { status: 'complete' }, restored);
    await listeners.startup();
    await sleep(1800);
    assert.equal(cloud.requests.length, 0);
    assert.equal(session.foldnex_session_started_v1, true);
  } finally {
    cloud.restore();
  }
});

test('the service worker keeps cloud labelling to new tabs and lets an on-device engine prepare the window', async () => {
  const W = 220;
  const tabs = makeTopicTabs(W, 22000, { food: 3, travel: 3 });
  const { sync, session } = installBrowser(tabs, { sync: { provider: 'openai', openaiApiKey: 'test-only', autoGroupNewTabs: true } });
  // A worker woken later in the browser session.
  session.foldnex_session_started_v1 = true;
  const listeners = installWorkerEvents();
  const cloud = installCloudFetch();
  const message = body => new Promise(resolve => listeners.message(body, {}, resolve));
  const newTab = async id => {
    const tab = { ...makeTopicTabs(W, id, { dev: 1 })[0], index: tabs.length };
    tabs.push(tab);
    await listeners.tabCreated({ ...tab, status: 'loading' });
    await listeners.tabUpdated(tab.id, { status: 'complete' }, tab);
    return tab;
  };
  try {
    await import('../background.js?service-worker-wiring');

    // Popup open and title changes on open tabs send nothing to the cloud.
    assert.deepEqual(await message({ type: 'PREPARE_GROUPING', windowId: W }), { ok: true });
    await listeners.tabUpdated(22000, { title: 'Easy ramen recipe 0 (2)' }, { ...tabs[0], title: 'Easy ramen recipe 0 (2)' });
    await sleep(1800);
    assert.equal(cloud.requests.length, 0);

    // A tab opened with Auto-group on is sent.
    const opened = await newTab(22090);
    assert.ok(await waitFor(() => cloud.requests.length === 1, 3000));
    assert.deepEqual(cloud.titles(), [opened.title]);

    // After a browser start, restored and already-open tabs are not.
    await listeners.startup();
    await newTab(22091);
    await sleep(1800);
    assert.equal(cloud.requests.length, 1);

    // An on-device engine labels the whole window when the popup opens.
    sync.provider = 'ollama';
    assert.deepEqual(await message({ type: 'PREPARE_GROUPING', windowId: W }), { ok: true });
    assert.ok(await waitFor(() => cloud.requests.length === 2, 3000));
    assert.ok(cloud.requests[1].url.startsWith('http://localhost:11434/'));
    assert.ok(cloud.titles().includes('Easy ramen recipe 1'));
  } finally {
    // The worker's pending plan refresh must not reach a real Ollama server after the test.
    sync.groupingStrategy = 'site';
    cloud.restore();
  }
});
