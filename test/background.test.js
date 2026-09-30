import assert from 'node:assert/strict';
import test from 'node:test';

import {
  configureOnDeviceMemory,
  getOnDeviceModelState,
  IMMEDIATE_UNLOAD_GRACE_MS,
  labelCacheScope,
  NAME_SYSTEM,
  resetNanoBases
} from '../src/ai-engine.js';
import { LearningCache, PlanMemory, TabLabelCache, WindowPlanStore } from '../src/cache-engine.js';
import {
  autoGroupWindow,
  classifyTabs,
  createBackgroundClassifier,
  createNewTabTracker,
  isOnDeviceEngine,
  loadBackgroundScope,
  PLAN_REFRESH_DELAY_MS,
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

/**
 * Chrome's Prompt API. Records label and name prompts and base creations,
 * with whether Foldnex still held a base (the model) when each load began;
 * setting `calls.createDelayMs` makes later loads that slow.
 */
function installNanoMock({ labelFor = keyForTitle, nameFor = name => name, nameDelayMs = 0 } = {}) {
  const calls = { labelPrompts: [], namePrompts: [], creates: 0, heldAtCreate: [], createDelayMs: 0 };
  const makeSession = createOptions => ({
    inputUsage: 300,
    async clone() {
      return makeSession(createOptions);
    },
    async prompt(text) {
      const naming = createOptions?.initialPrompts?.[0]?.content === NAME_SYSTEM;
      (naming ? calls.namePrompts : calls.labelPrompts).push(text);
      if (naming && nameDelayMs > 0) await sleep(nameDelayMs);
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
    async create(options) {
      calls.creates++;
      calls.heldAtCreate.push(getOnDeviceModelState().loaded);
      if (calls.createDelayMs > 0) await sleep(calls.createDelayMs);
      return makeSession(options);
    }
  };
  return calls;
}

function removeNanoMock() {
  resetNanoBases();
  delete globalThis.LanguageModel;
  delete globalThis.self;
}

/** An OpenAI-compatible endpoint that labels every row and tracks concurrency. */
function installCloudFetch({ delayMs = 0, failFirst = false } = {}) {
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
    requests.push({ url, rows, signal: options.signal });
    if (failFirst && requests.length === 1) return { ok: false, status: 503, async text() { return 'temporarily unavailable'; } };
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
  const settings = await chrome.storage.sync.get(null);
  await TabLabelCache.store(new Map(tabs.map(tab => [tab.id, keyForTitle(tab.title)])), fingerprintById, engine, {
    scope: labelCacheScope({ ...settings, provider: engine })
  });
}

async function lookupSelectedLabels(tabs) {
  const settings = await chrome.storage.sync.get(null);
  return TabLabelCache.lookup(tabs, { scope: labelCacheScope(settings) });
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
  installBrowser(tabs, { sync: { provider: 'gemini_nano', backgroundPrep: true } });
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
    assert.ok(await waitFor(async () => (await lookupSelectedLabels(tabs)).missing.length === 0, 2000));
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
  installBrowser(tabs, { sync: { provider: 'gemini_nano', backgroundPrep: true } });
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
    assert.ok(await waitFor(async () => (await lookupSelectedLabels(tabs)).missing.length === 0, 3000));
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
    const ids = tabs.map(tab => tab.id);
    const result = await classifyTabs(ids, null, { admission: { freshIds: ids, reasons: ids.map(id => [id, 'load']) } });
    assert.equal(cloud.requests.length, 3);
    assert.equal(cloud.peak(), 1);
    assert.equal(result.labelledIds.length, 60);
  } finally {
    cloud.restore();
  }
});

test('the shared cloud dispatch requires explicit fresh-page admission and excludes title-only work', async () => {
  const tabs = makeTopicTabs(228, 22800, { dev: 3 });
  installBrowser(tabs, { sync: { provider: 'openai', openaiApiKey: 'test-only', autoGroupNewTabs: true } });
  const cloud = installCloudFetch();
  const ids = tabs.map(tab => tab.id);
  try {
    assert.deepEqual((await classifyTabs(ids)).labelledIds, []);
    assert.equal(cloud.requests.length, 0);
    const result = await classifyTabs(ids, null, {
      admission: { freshIds: ids.slice(1), reasons: [[ids[0], 'load'], [ids[1], 'title'], [ids[2], 'load']] }
    });
    assert.deepEqual(result.labelledIds, [ids[2]]);
    assert.deepEqual(cloud.titles(), [tabs[2].title]);
  } finally {
    cloud.restore();
  }
});

test('background dispatch uses the local settings admitted before tabs are read', async () => {
  for (const transition of ['endpoint', 'provider']) {
    const tabs = makeTopicTabs(229, 22900, { dev: 2 });
    const { sync } = installBrowser(tabs, { sync: { provider: 'ollama', backgroundPrep: true, autoGroupNewTabs: true } });
    const cloud = installCloudFetch();
    const get = chrome.tabs.get;
    let changed = false;
    chrome.tabs.get = async id => {
      if (!changed) {
        changed = true;
        if (transition === 'endpoint') sync.ollamaBaseUrl = 'https://remote.example/v1';
        else Object.assign(sync, { provider: 'openai', openaiApiKey: 'test-only' });
      }
      return get(id);
    };
    const classifier = createBackgroundClassifier({ flushDelayMs: 5, refreshDelayMs: 60000 });
    try {
      classifier.enqueue(tabs.map(tab => tab.id));
      assert.ok(await waitFor(() => cloud.requests.length === 1), transition);
      await classifier.whenIdle();
      assert.ok(cloud.requests.every(request => request.url.startsWith('http://localhost:11434/')), transition);
      assert.equal(cloud.titles().length, 2);
    } finally {
      classifier.pause();
      cloud.restore();
    }
  }
});

test('a reset during background provider labelling discards its old labels and allows a fresh request', async () => {
  const tabs = makeTopicTabs(230, 23000, { dev: 2 });
  const { local } = installBrowser(tabs, { sync: { provider: 'openai', openaiApiKey: 'test-only', autoGroupNewTabs: true } });
  const cloud = installCloudFetch({ delayMs: 60 });
  const ids = tabs.map(tab => tab.id);
  const context = { admission: { freshIds: ids, reasons: ids.map(id => [id, 'load']) } };
  try {
    const pending = classifyTabs(ids, null, context);
    assert.ok(await waitFor(() => cloud.requests.length === 1));
    await LearningCache.resetRules();
    assert.equal((await pending).aborted, true);
    assert.ok(!(TabLabelCache.STORAGE_KEY in local));
    const fresh = await classifyTabs(ids, null, context);
    assert.deepEqual(fresh.labelledIds, ids);
    assert.equal(cloud.requests.length, 2);
  } finally {
    cloud.restore();
  }
});

test('a reset during background Nano naming discards names and the window plan', async () => {
  const W = 231;
  const tabs = makeTopicTabs(W, 23100, { food: 3, travel: 3 });
  const { local } = installBrowser(tabs, { sync: { provider: 'gemini_nano', backgroundPrep: true } });
  await cacheLabels(tabs);
  const nano = installNanoMock({ nameDelayMs: 60 });
  try {
    const pending = refreshAndAutoGroup(W, null, { autoGroup: false });
    assert.ok(await waitFor(() => nano.namePrompts.length > 0));
    await LearningCache.resetRules();
    assert.equal(await pending, null);
    assert.ok(!(PlanMemory.STORAGE_KEY in local));
    assert.equal(await WindowPlanStore.get(W), null);
    await cacheLabels(tabs);
    assert.ok(await refreshAndAutoGroup(W, null, { autoGroup: false }));
    assert.equal(nano.namePrompts.length, 2, 'a reset also retires the old naming-attempt fence');
  } finally {
    removeNanoMock();
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

  assert.deepEqual(await loadBackgroundScope({ provider: 'openai' }), { allowed: false, cleanupFollowUp: false, onDevice: false, autoGroup: false });
  assert.deepEqual(await loadBackgroundScope({ provider: 'openai', autoGroupNewTabs: true }), { allowed: true, cleanupFollowUp: false, onDevice: false, autoGroup: true });
  assert.deepEqual(await loadBackgroundScope({ provider: 'ollama', ollamaBaseUrl: 'https://ollama.example.com/v1' }), { allowed: false, cleanupFollowUp: false, onDevice: false, autoGroup: false });
  assert.deepEqual(await loadBackgroundScope({ provider: 'ollama' }), { allowed: false, cleanupFollowUp: true, onDevice: true, autoGroup: false });
  assert.deepEqual(await loadBackgroundScope({ provider: 'ollama', backgroundPrep: true }), { allowed: true, cleanupFollowUp: true, onDevice: true, autoGroup: false });
  assert.equal((await loadBackgroundScope({ provider: 'gemini_nano', groupingStrategy: 'site' })).cleanupFollowUp, false);
  assert.equal((await loadBackgroundScope({ provider: 'gemini_nano' })).allowed, false);
  assert.equal((await loadBackgroundScope({ provider: 'gemini_nano', backgroundPrep: true })).allowed, true);
  assert.equal((await loadBackgroundScope({ provider: 'gemini_nano', autoGroupNewTabs: true })).allowed, true, 'Auto-group needs labels');
  assert.equal((await loadBackgroundScope({ provider: 'openai', backgroundPrep: true })).allowed, false, 'preparation never opens the cloud');
  assert.equal((await loadBackgroundScope({ provider: 'offline', backgroundPrep: true })).allowed, false);
  assert.equal((await loadBackgroundScope({ provider: 'gemini_nano', groupingStrategy: 'site' })).allowed, false);
});

test('an on-device engine labels and names in the background only with background preparation or Auto-group', async () => {
  const W = 224;
  const tabs = makeTopicTabs(W, 22400, { food: 3, travel: 3 });
  const settings = { provider: 'gemini_nano' };
  installBrowser(tabs, { sync: settings });
  const nano = installNanoMock();
  const refreshed = [];
  const classifier = createBackgroundClassifier({
    refresh: async windowId => {
      refreshed.push(windowId);
      return null;
    },
    flushDelayMs: 5,
    refreshDelayMs: 5
  });
  try {
    // Off: queued tabs, a popup open and a cleanup's plan refresh never reach the model.
    classifier.enqueue(tabs.map(tab => tab.id));
    await classifier.prioritize(W);
    classifier.scheduleWindowPlanRefresh(W);
    await sleep(120);
    assert.equal(nano.labelPrompts.length, 0);
    assert.equal(nano.creates, 0);
    assert.deepEqual(refreshed, []);
    assert.deepEqual(classifier.pendingTabIds(), []);

    // Background preparation on: the same work labels every tab and refreshes the plan.
    settings.backgroundPrep = true;
    classifier.enqueue(tabs.map(tab => tab.id));
    assert.ok(await waitFor(async () => (await lookupSelectedLabels(tabs)).missing.length === 0, 2000));
    assert.ok(await waitFor(() => refreshed.length === 1));
  } finally {
    classifier.pause();
    removeNanoMock();
  }

  // Auto-group alone allows it too, because it needs labels.
  const others = makeTopicTabs(W + 1, 22450, { dev: 2 });
  installBrowser(others, { sync: { provider: 'gemini_nano', autoGroupNewTabs: true } });
  const again = installNanoMock();
  const queue = createBackgroundClassifier({ refresh: async () => null, flushDelayMs: 5 });
  try {
    await queue.prioritize(W + 1);
    assert.ok(await waitFor(async () => (await lookupSelectedLabels(others)).missing.length === 0, 2000));
    assert.ok(again.labelPrompts.length > 0);
  } finally {
    queue.pause();
    removeNanoMock();
  }
});

test('under the immediately setting the background plan refresh names groups on the model its labelling loaded', async t => {
  const W = 227;
  const tabs = makeTopicTabs(W, 22700, { food: 3, travel: 3, dev: 3 });
  installBrowser(tabs, { sync: { provider: 'gemini_nano', backgroundPrep: true, modelUnloadAfter: 'immediately' } });
  const nano = installNanoMock();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 5_000_000 });
  // Mocked timers move in steps; setImmediate stays real and lets promise work run.
  const advance = async ms => {
    for (let step = 0; step < ms; step += 100) {
      t.mock.timers.tick(100);
      for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    }
  };
  configureOnDeviceMemory({ unloadAfter: 'immediately' });
  // The real plan refresh delay; only the flush debounce is shortened.
  const classifier = createBackgroundClassifier({ flushDelayMs: 5 });
  try {
    classifier.enqueue(tabs.map(tab => tab.id));
    await advance(200);
    assert.ok(nano.labelPrompts.length > 0);
    assert.equal(nano.namePrompts.length, 0);

    await advance(PLAN_REFRESH_DELAY_MS + 500);
    assert.equal(nano.namePrompts.length, 1);
    assert.deepEqual(nano.heldAtCreate, [false, true], 'the name base loads while the label base still holds the model');

    // Right after use still means right after use.
    await advance(IMMEDIATE_UNLOAD_GRACE_MS);
    assert.equal(getOnDeviceModelState().loaded, false);
  } finally {
    classifier.pause();
    configureOnDeviceMemory({ unloadAfter: '5m' });
    removeNanoMock();
  }
});

test('clearing the queue stops the running flush and drops queued tabs, retries and plan refreshes', async () => {
  installBrowser(makeTopicTabs(225, 22500, { food: 3 }));
  const signals = [];
  const refreshes = [];
  const classifier = createBackgroundClassifier({
    classify: (ids, signal) => {
      signals.push(signal);
      if (signals.length === 1) {
        return Promise.resolve({ windowIds: [225], storedWindowIds: [], labelledIds: [], unlabelledIds: ids });
      }
      return new Promise(resolve => signal.addEventListener('abort', () => resolve({ aborted: true }), { once: true }));
    },
    refresh: async windowId => {
      refreshes.push(windowId);
      return null;
    },
    scope: ON_DEVICE,
    flushDelayMs: 5,
    refreshDelayMs: 40,
    retryDelaysMs: [40, 40, 40]
  });
  try {
    // One tab waits for a retry, one is being labelled, one is queued, and a plan refresh is due.
    classifier.enqueue([22500]);
    assert.ok(await waitFor(() => signals.length === 1));
    classifier.enqueue([22501]);
    assert.ok(await waitFor(() => signals.length === 2));
    classifier.enqueue([22502]);
    classifier.scheduleWindowPlanRefresh(225);

    await classifier.clear();
    assert.equal(signals[1].aborted, true);
    assert.deepEqual(classifier.pendingTabIds(), []);
    await sleep(150);
    assert.equal(signals.length, 2, 'no retry and no returned work runs');
    assert.deepEqual(refreshes, []);

    // Work queued afterwards runs as usual.
    classifier.enqueue([22502]);
    assert.ok(await waitFor(() => signals.length === 3));
  } finally {
    classifier.pause();
  }
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

test('nonzero navigation settling coalesces cloud counters and preserves one final useful title per page', async () => {
  const W = 232;
  const tabs = makeTopicTabs(W, 23200, { dev: 1 });
  const tab = tabs[0];
  tab.title = 'BTC 61,000';
  installBrowser(tabs, { sync: { provider: 'openai', openaiApiKey: 'test-only', autoGroupNewTabs: true } });
  const cloud = installCloudFetch();
  const classifier = createBackgroundClassifier({ flushDelayMs: 5, refreshDelayMs: 60000, navigationSettleMs: 160 });
  const on = { autoGroup: true };
  const title = async text => {
    tab.title = text;
    await classifier.noteTabUpdated(tab.id, { title: text }, { ...tab }, on);
  };
  try {
    await classifier.noteTabCreated({ ...tab, status: 'loading' }, on);
    await classifier.noteTabUpdated(tab.id, { status: 'complete' }, tab, on);
    assert.ok(await waitFor(async () => cloud.requests.length === 1 && (await lookupSelectedLabels(tabs)).missing.length === 0));
    for (let i = 1; i <= 5; i++) await title(`BTC 61,00${i}`);
    await sleep(220);
    assert.equal(cloud.requests.length, 1, 'numeric title churn does not spend a second request');

    tab.url += '/next';
    tab.title = 'Loading';
    await classifier.noteTabUpdated(tab.id, { url: tab.url, status: 'loading' }, { ...tab, status: 'loading' }, on);
    await classifier.noteTabUpdated(tab.id, { status: 'complete' }, tab, on);
    assert.ok(await waitFor(async () => cloud.requests.length === 2 && (await lookupSelectedLabels(tabs)).missing.length === 0));
    await title('Cheap flights');
    await title('Cheap flights to Tokyo');
    await title('Cheap flights to Tokyo 27');
    assert.ok(await waitFor(() => cloud.requests.length === 3));
    assert.equal(cloud.requests[2].rows[0][1], 'Cheap flights to Tokyo 27');
    assert.ok(await waitFor(async () => (await lookupSelectedLabels(tabs)).labels.get(tab.id)?.c === 'travel'));
    await title('Cheap flights to Osaka 28');
    await sleep(220);
    assert.equal(cloud.requests.length, 3, 'settling is bounded to one useful follow-up');
  } finally {
    classifier.pause();
    cloud.restore();
  }
});

test('title settling retains failed-page retries and uses the final title on the successful retry', async () => {
  const tabs = makeTopicTabs(233, 23300, { dev: 1 });
  const tab = tabs[0];
  tab.title = 'Loading';
  installBrowser(tabs, { sync: { provider: 'openai', openaiApiKey: 'test-only', autoGroupNewTabs: true } });
  const cloud = installCloudFetch({ failFirst: true });
  const classifier = createBackgroundClassifier({ flushDelayMs: 5, refreshDelayMs: 60000, navigationSettleMs: 140, retryDelaysMs: [60, 100] });
  const on = { autoGroup: true };
  try {
    await classifier.noteTabCreated({ ...tab, status: 'loading' }, on);
    await classifier.noteTabUpdated(tab.id, { status: 'complete' }, tab, on);
    assert.ok(await waitFor(() => cloud.requests.length === 1));
    tab.title = 'React hooks reference';
    await classifier.noteTabUpdated(tab.id, { title: tab.title }, tab, on);
    assert.ok(await waitFor(async () => (await lookupSelectedLabels(tabs)).labels.get(tab.id)?.c === 'dev'));
    await sleep(180);
    assert.equal(cloud.requests.length, 2);
    assert.equal(cloud.requests[1].rows[0][1], tab.title);
  } finally {
    classifier.pause();
    cloud.restore();
  }
});

test('configuration invalidation aborts immediately, drops old admissions and preserves cleanup pause holds', async () => {
  const tabs = makeTopicTabs(234, 23400, { dev: 2 });
  installBrowser(tabs);
  const signals = [];
  const classifier = createBackgroundClassifier({
    classify: async (ids, signal) => {
      signals.push(signal);
      if (signals.length === 1) return new Promise(resolve => signal.addEventListener('abort', () => resolve({ aborted: true }), { once: true }));
      return { labelledIds: ids, unlabelledIds: [] };
    },
    refresh: async () => null,
    scope: ON_DEVICE,
    flushDelayMs: 5
  });
  try {
    classifier.enqueue([tabs[0].id]);
    assert.ok(await waitFor(() => signals.length === 1));
    classifier.pause();
    classifier.invalidate();
    assert.equal(signals[0].aborted, true);
    await classifier.whenIdle();
    classifier.enqueue([tabs[1].id]);
    await sleep(40);
    assert.equal(signals.length, 1, 'an existing cleanup hold remains in force');
    classifier.resume();
    assert.ok(await waitFor(() => signals.length === 2));
    assert.deepEqual(classifier.pendingTabIds(), []);
  } finally {
    classifier.pause();
  }
});

test('clear discards a provider that settles after its bounded idle wait', async () => {
  const tabs = makeTopicTabs(236, 23600, { dev: 2 });
  installBrowser(tabs);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let attempts = 0;
  const classifier = createBackgroundClassifier({
    classify: async ids => {
      attempts++;
      if (attempts === 1) await gate;
      return { labelledIds: [], unlabelledIds: ids };
    },
    refresh: async () => null,
    scope: ON_DEVICE,
    flushDelayMs: 5,
    retryDelaysMs: [10]
  });
  try {
    classifier.enqueue([tabs[0].id]);
    assert.ok(await waitFor(() => attempts === 1));
    await classifier.clear({ waitMs: 10 });
    release();
    await classifier.whenIdle();
    await sleep(60);
    assert.equal(attempts, 1);
    assert.deepEqual(classifier.pendingTabIds(), []);
  } finally {
    release();
    classifier.pause();
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

test('the worker aborts allowed endpoint and provider changes before rereading settings and drops existing tabs', async () => {
  const W = 235;
  const tabs = makeTopicTabs(W, 23500, { dev: 60 });
  const { sync, session } = installBrowser(tabs, { sync: { provider: 'ollama', backgroundPrep: true, autoGroupNewTabs: true } });
  session.foldnex_session_started_v1 = true;
  const listeners = installWorkerEvents();
  const cloud = installCloudFetch({ delayMs: 120 });
  const message = body => new Promise(resolve => listeners.message(body, {}, resolve));
  const change = (key, newValue) => {
    const oldValue = sync[key];
    sync[key] = newValue;
    listeners.storageChanged({ [key]: { oldValue, newValue } }, 'sync');
  };
  try {
    await import('../background.js?allowed-configuration-invalidation');
    await message({ type: 'PREPARE_GROUPING', windowId: W });
    assert.ok(await waitFor(() => cloud.requests.length === 1));
    change('ollamaBaseUrl', 'https://remote.example/v1');
    assert.equal(cloud.requests[0].signal.aborted, true, 'endpoint changes abort in the event callback');
    await sleep(180);
    assert.equal(cloud.requests.length, 1, 'later local batches and existing-page admissions are dropped');

    const fresh = { ...makeTopicTabs(W, 23590, { food: 1 })[0], index: tabs.length };
    tabs.push(fresh);
    await listeners.tabCreated({ ...fresh, status: 'loading' });
    await listeners.tabUpdated(fresh.id, { status: 'complete' }, fresh);
    assert.ok(await waitFor(() => cloud.requests.length === 2));
    assert.ok(cloud.requests[1].url.startsWith('https://remote.example/'));
    change('provider', 'openai');
    assert.equal(cloud.requests[1].signal.aborted, true, 'allowed-to-allowed provider changes also abort immediately');
    await sleep(180);
    assert.equal(cloud.requests.length, 2);
  } finally {
    change('groupingStrategy', 'site');
    await sleep(140);
    cloud.restore();
  }
});

test('retiring configuration admissions preserves explicit ungroup choices and accepts later fresh pages', async () => {
  installBrowser([]);
  const tracker = createNewTabTracker();
  await tracker.markNew(23801);
  await tracker.markTakenOut([[23801, 'synthetic-page-key']]);
  await tracker.markNew(23802);
  await tracker.retireAdmissions();
  assert.deepEqual(await tracker.freshIds(), []);
  assert.deepEqual(await tracker.candidateIds(), []);
  assert.equal(await tracker.outKey(23801), 'synthetic-page-key');
  await tracker.markNew(23803);
  assert.deepEqual(await tracker.freshIds(), [23803]);
  assert.deepEqual(await tracker.candidateIds(), [23803]);
  await tracker.markNew(23804, { isCurrent: () => false });
  assert.deepEqual(await tracker.freshIds(), [23803], 'delayed stale admissions are rejected inside the tracker');
});

test('a pending local window priority read cannot re-admit old fresh tabs after switching to cloud', async () => {
  const W = 238;
  const tabs = makeTopicTabs(W, 23800, { dev: 1 });
  const { sync } = installBrowser(tabs, { sync: { provider: 'ollama', autoGroupNewTabs: true, backgroundPrep: true } });
  const classifier = createBackgroundClassifier({ flushDelayMs: 5, refreshDelayMs: 10000 });
  const cloud = installCloudFetch();
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const queried = new Promise(resolve => { reached = resolve; });
  const originalQuery = chrome.tabs.query;
  try {
    await classifier.noteTabCreated({ ...tabs[0], status: 'loading' }, { autoGroup: true });
    chrome.tabs.query = async query => {
      if (query.windowId === W) { reached(); await gate; }
      return originalQuery(query);
    };
    const prioritizing = classifier.prioritize(W);
    await queried;
    sync.provider = 'openai';
    sync.openaiApiKey = 'synthetic-boundary-key';
    classifier.invalidate();
    release();
    await prioritizing;
    chrome.tabs.query = originalQuery;
    await sleep(30);
    await classifier.whenIdle();
    assert.equal(cloud.requests.length, 0, 'old local reads cannot refill the cloud queue');
    await classifier.noteTabUpdated(tabs[0].id, { status: 'complete' }, tabs[0], { autoGroup: true });
    await sleep(30);
    await classifier.whenIdle();
    assert.equal(cloud.requests.length, 0, 'the old fresh-page admission is retired');
    const fresh = { ...makeTopicTabs(W, 23810, { food: 1 })[0], index: 1 };
    tabs.push(fresh);
    await classifier.noteTabCreated({ ...fresh, status: 'loading' }, { autoGroup: true });
    await classifier.noteTabUpdated(fresh.id, { status: 'complete' }, fresh, { autoGroup: true });
    assert.ok(await waitFor(() => cloud.requests.length === 1));
    await classifier.whenIdle();
    assert.equal(cloud.requests.length, 1, 'a newly admitted cloud page still works');
    assert.equal(cloud.requests[0].rows.length, 1);
    assert.equal(cloud.requests[0].rows[0][1], fresh.title);
  } finally {
    release();
    chrome.tabs.query = originalQuery;
    classifier.pause();
    cloud.restore();
  }
});

test('the worker resolves private group members before reading or writing group-title state', async () => {
  const W = 237;
  const group = { id: 237, windowId: W, title: 'Private research', color: 'blue' };
  const tabs = makeTopicTabs(W, 23700, { dev: 2 }).map(tab => ({ ...tab, incognito: true, groupId: group.id }));
  const { local, session } = installBrowser(tabs, { chromeGroups: [group] });
  const listeners = installWorkerEvents();
  await import('../background.js?private-group-event-boundary');
  await listeners.groupUpdated(group);
  await listeners.groupUpdated({ ...group, title: 'Private changed name' });
  assert.deepEqual(Object.keys(session).filter(key => /^foldnex_(expected_group_update|group_title_baseline)_/.test(key)), []);
  assert.ok(!(PlanMemory.STORAGE_KEY in local));
  assert.deepEqual(local[LearningCache.STORAGE_KEY] || [], []);
});

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

test('the service worker prepares an on-device engine only when asked and lets go of Nano on request or an engine switch', async () => {
  const W = 226;
  const tabs = makeTopicTabs(W, 22600, { food: 3, travel: 3 });
  const { sync, session } = installBrowser(tabs, { sync: { provider: 'gemini_nano', setupChoice: 'nano' } });
  session.foldnex_session_started_v1 = true;
  const listeners = installWorkerEvents();
  const nano = installNanoMock();
  let availability = 'downloading';
  globalThis.LanguageModel.availability = async () => availability;
  const message = body => new Promise(resolve => listeners.message(body, {}, resolve));
  const state = () => message({ type: 'GET_ON_DEVICE_MODEL_STATE' });
  const change = values => {
    const changes = {};
    for (const [key, newValue] of Object.entries(values)) {
      changes[key] = { oldValue: sync[key], newValue };
      sync[key] = newValue;
    }
    listeners.storageChanged(changes, 'sync');
  };
  const missing = async list => (await lookupSelectedLabels(list)).missing.length;
  try {
    await import('../background.js?on-device-preparation');

    // Without background preparation, a browser start and page loads label nothing.
    await listeners.startup();
    await listeners.tabUpdated(tabs[0].id, { status: 'complete' }, tabs[0]);
    await sleep(1800);
    assert.equal(nano.labelPrompts.length, 0);
    // A cleanup while the model is not ready places tabs by address. Without
    // preparation, an on-device engine still finishes those tabs, then stops.
    const first = await message({ type: 'TRIGGER_GROUPING', windowId: W });
    assert.ok(first.result.provisionalTabs > 0);
    assert.equal(first.result.provisionalInBackground, true);
    assert.equal(nano.creates, 0);
    assert.deepEqual(await state(), { ok: true, loaded: false, idleMs: null, unloadAfter: '5m' });

    // Nothing warms the model before the setup card is answered.
    availability = 'available';
    delete sync.setupChoice;
    assert.deepEqual(await message({ type: 'PREPARE_GROUPING', windowId: W }), { ok: true });
    await sleep(50);
    assert.equal(nano.creates, 0);

    // Then opening the popup warms Nano for the click that usually follows.
    change({ setupChoice: 'nano' });
    assert.deepEqual(await message({ type: 'PREPARE_GROUPING', windowId: W }), { ok: true });
    assert.ok(await waitFor(() => nano.creates >= 1));
    const warm = await state();
    assert.equal(warm.loaded, true);
    assert.equal(typeof warm.idleMs, 'number');
    assert.ok(await waitFor(async () => await missing(tabs) === 0, 9000), 'the cleanup follow-up labels its tabs');

    // A page loaded without preparation waits; turning preparation on queues it.
    const extra = { ...makeTopicTabs(W, 22680, { travel: 1 })[0], index: tabs.length };
    tabs.push(extra);
    await listeners.tabUpdated(extra.id, { status: 'complete' }, extra);
    await sleep(1800);
    assert.equal(await missing([extra]), 1);
    change({ backgroundPrep: true });
    assert.ok(await waitFor(async () => await missing(tabs) === 0, 4000));

    // Unload now releases the sessions; a second request finds nothing to release.
    assert.deepEqual(await message({ type: 'UNLOAD_ON_DEVICE_MODEL' }), { ok: true, released: true });
    assert.equal((await state()).loaded, false);
    assert.deepEqual(await message({ type: 'UNLOAD_ON_DEVICE_MODEL' }), { ok: true, released: false });

    // A click that finds the model cold hands its provisional tabs to the background.
    const later = makeTopicTabs(W, 22690, { dev: 2 }).map((tab, i) => ({ ...tab, index: tabs.length + i }));
    tabs.push(...later);
    nano.createDelayMs = 2000;
    const cold = await message({ type: 'TRIGGER_GROUPING', windowId: W });
    assert.equal(cold.result.fallbackCode, 'nano_loading');
    assert.equal(cold.result.provisionalInBackground, true);
    assert.ok(await waitFor(async () => await missing(later) === 0, 5000));
    nano.createDelayMs = 0;

    // Turning preparation off stops background labelling again.
    change({ backgroundPrep: false });
    await sleep(50);
    const prompts = nano.labelPrompts.length;
    const opened = { ...makeTopicTabs(W, 22695, { food: 1 })[0], index: tabs.length };
    tabs.push(opened);
    await listeners.tabUpdated(opened.id, { status: 'complete' }, opened);
    await sleep(1800);
    assert.equal(nano.labelPrompts.length, prompts);

    // 'immediately' never warms a model it would release 6 s later.
    change({ modelUnloadAfter: 'immediately' });
    await message({ type: 'UNLOAD_ON_DEVICE_MODEL' });
    const creates = nano.creates;
    await message({ type: 'PREPARE_GROUPING', windowId: W });
    await sleep(100);
    assert.equal(nano.creates, creates);

    // The unload setting is reported, and switching engine lets go of Nano.
    change({ modelUnloadAfter: '15m' });
    await message({ type: 'PREPARE_GROUPING', windowId: W });
    assert.ok(await waitFor(async () => (await state()).loaded));
    assert.equal((await state()).unloadAfter, '15m');
    change({ provider: 'offline' });
    assert.ok(await waitFor(async () => !(await state()).loaded, 2000));
  } finally {
    // The worker's pending work must not reach later tests.
    sync.groupingStrategy = 'site';
    configureOnDeviceMemory({ unloadAfter: '5m' });
    removeNanoMock();
  }
});

test('Run from toolbar keeps the popup until the setup card is answered', async () => {
  const tabs = makeTopicTabs(227, 22700, { food: 1 });
  const { sync } = installBrowser(tabs, { sync: { oneClickIconMode: true, groupingStrategy: 'site' } });
  const listeners = installWorkerEvents();
  const popups = [];
  chrome.action.setPopup = async ({ popup }) => { popups.push(popup); };
  await import('../background.js?toolbar-setup');
  assert.ok(await waitFor(() => popups.length > 0));
  assert.equal(popups.at(-1), 'popup.html');

  sync.setupChoice = 'cloud';
  listeners.storageChanged({ setupChoice: { newValue: 'cloud' } }, 'sync');
  assert.ok(await waitFor(() => popups.at(-1) === ''));
});
