import assert from 'node:assert/strict';
import test from 'node:test';

import { LearningCache, PlanMemory, PlanOfferStore, readResetEpoch, tabSetSignature, WindowPlanStore } from '../src/cache-engine.js';
import { buildLockedGroups, getGroupableTabs, getRunScope, loadGroupingSettings, lockedPartitionKey } from '../src/grouper.js';
import {
  attachNewTab,
  createBackgroundClassifier,
  createNewTabTracker,
  isLocalOllama
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

/* ------------------------------------------------------------------------ */
/* Auto-group candidates                                                    */
/* ------------------------------------------------------------------------ */

function recordingClassifier({ tracker = createNewTabTracker(), ...options } = {}) {
  const attached = [];
  const classifier = createBackgroundClassifier({
    attach: async id => {
      attached.push(id);
      return { placed: false };
    },
    tracker,
    ...options
  });
  return { classifier, tracker, attached };
}

test('only a tab opened or navigated with Auto-group on becomes a candidate, until it is grouped or taken out', async () => {
  const W = 206;
  const tabs = makeTopicTabs(W, 20600, { food: 4 });
  installBrowser(tabs);
  const { classifier, attached, tracker } = recordingClassifier();
  const on = { autoGroup: true };
  const [a, b, c, d] = tabs;
  try {
    // Opened while Auto-group was on, then loaded: it is attached locally.
    await classifier.noteTabCreated({ ...a, status: 'loading', url: '', pendingUrl: a.url }, on);
    await classifier.noteTabUpdated(a.id, { status: 'complete' }, a, on);
    assert.deepEqual(attached, [a.id]);

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
    assert.equal(attached.length, 1);
    assert.deepEqual(await tracker.candidateIds(), []);

    // Opening a new page makes the taken-out tab a candidate again.
    const next = 'https://www.food-site-20600.com/another';
    await classifier.noteTabUpdated(a.id, { status: 'loading', url: next }, { ...a, status: 'loading', url: next }, on);
    await classifier.noteTabUpdated(a.id, { status: 'complete' }, { ...a, url: next }, on);
    assert.deepEqual(attached, [a.id, a.id]);

    // Ungroup all: the window's tabs stop being candidates.
    await classifier.noteWindowUngrouped(W);
    assert.deepEqual(await tracker.candidateIds(), []);

    // Opened while Auto-group was off: not a candidate.
    await classifier.noteTabCreated({ ...d, status: 'loading' }, { autoGroup: false });
    await classifier.noteTabUpdated(d.id, { status: 'complete' }, d, { autoGroup: false });
    await sleep(60);
    assert.equal(attached.length, 2);

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

test('an address the page rewrites itself is not a new page', async () => {
  const W = 223;
  const maps = {
    id: 22300, windowId: W, index: 0, pinned: false, incognito: false, status: 'complete', groupId: -1,
    title: 'Google Maps', url: 'https://www.google.com/maps/@51.50,-0.12,15z'
  };
  const other = { ...makeTopicTabs(W, 22301, { travel: 1 })[0], index: 1 };
  installBrowser([maps, other], { sync: { provider: 'openai', openaiApiKey: 'test-only', autoGroupNewTabs: true } });
  const cloud = installCloudFetch();
  const tracker = createNewTabTracker();
  const cloudQueue = createBackgroundClassifier({ tracker });
  const on = { autoGroup: true };
  try {
    // An old map tab the user took out of a group, panned eight times.
    await cloudQueue.noteTabUpdated(maps.id, { groupId: -1 }, maps, on);
    for (let i = 1; i <= 8; i++) {
      maps.url = `https://www.google.com/maps/@51.${50 + i},-0.12,15z`;
      // Chrome may or may not report the status with a same-document change.
      const changeInfo = i % 2 ? { url: maps.url } : { status: 'complete', url: maps.url };
      await cloudQueue.noteTabUpdated(maps.id, changeInfo, { ...maps }, on);
      await sleep(40);
    }
    await sleep(100);
    assert.deepEqual(await tracker.candidateIds(), [], 'a taken-out tab stays out');
    assert.deepEqual(await tracker.freshIds(), [], 'an old tab does not become new');
    assert.equal(cloud.requests.length, 0);
  } finally {
    cloudQueue.pause();
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
    sync: { provider: 'offline', groupingStrategy: 'task', autoGroupNewTabs: true },
    chromeGroups: [{ id: 71, windowId: W, title: 'Food & Recipes' }],
    liveGroups: true
  });
  const classifier = createBackgroundClassifier();
  const on = { autoGroup: true };
  try {
    // Every tab is ungrouped, as Ungroup all leaves them.
    assert.deepEqual(calls.group, []);

    // The food tabs are grouped again; the user takes one out.
    const food = tabs.filter(tab => keyForTitle(tab.title) === 'food');
    for (const tab of food) tab.groupId = 71;
    const removed = food[0];
    removed.groupId = -1;
    await classifier.noteTabUpdated(removed.id, { groupId: -1 }, removed, on);

    // A new food tab loads: it joins the food group, the removed tab does not.
    const fresh = { ...makeTopicTabs(W, 20790, { food: 1 })[0], index: tabs.length, title: 'Easy ramen recipe with miso', status: 'loading' };
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
  }
});

/* ------------------------------------------------------------------------ */
/* Ollama on this device                                                    */
/* ------------------------------------------------------------------------ */

test('only Ollama on a loopback address is local', async () => {
  assert.equal(isLocalOllama({ provider: 'ollama' }), true);
  for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:11434/v1', 'http://[::1]:11434/v1']) {
    assert.equal(isLocalOllama({ provider: 'ollama', ollamaBaseUrl: url }), true, url);
  }
  assert.equal(isLocalOllama({ provider: 'ollama', ollamaBaseUrl: 'https://ollama.example.com/v1' }), false);
  assert.equal(isLocalOllama({ provider: 'ollama', ollamaBaseUrl: 'http://localhost.example.com/v1' }), false);
  for (const provider of [undefined, 'gemini_nano', 'openai', 'offline']) assert.equal(isLocalOllama({ provider }), false, provider);
});

/* ------------------------------------------------------------------------ */
/* Pause                                                                    */
/* ------------------------------------------------------------------------ */

test('nested pauses hold Auto-group until the last resume, and a settings change keeps the hold', async () => {
  const W = 219;
  const tabs = makeTopicTabs(W, 21900, { food: 2 });
  installBrowser(tabs);
  const { classifier, tracker, attached } = recordingClassifier();
  const on = { autoGroup: true };
  const [tab] = tabs;
  const load = () => classifier.noteTabUpdated(tab.id, { status: 'complete' }, tab, on);
  try {
    await tracker.markNew(tab.id);
    classifier.pause();
    classifier.pause();
    await load();
    classifier.resume();
    await load();
    assert.deepEqual(attached, [], 'still paused');
    classifier.resume();
    await load();
    assert.deepEqual(attached, [tab.id]);

    // A settings change retires old admissions and leaves a cleanup hold in force.
    classifier.pause();
    classifier.invalidate();
    await classifier.whenIdle();
    await tracker.markNew(tab.id);
    await load();
    assert.deepEqual(attached, [tab.id], 'an existing cleanup hold remains in force');
    classifier.resume();
    await load();
    assert.deepEqual(attached, [tab.id, tab.id]);
  } finally {
    classifier.pause();
  }
});

/* ------------------------------------------------------------------------ */
/* Auto-group consent: an attach in flight                                  */
/* ------------------------------------------------------------------------ */

/**
 * A window with a Coding group of three React tabs and one new React tab
 * whose attach stops at its first tabGroups.query until released. `during`
 * runs while it waits. Returns the tabs.group calls made.
 */
async function attachInFlight(W, during, { gateAt = 1 } = {}) {
  const tabs = makeTopicTabs(W, W * 100, { dev: 4 });
  tabs.slice(0, 3).forEach(item => { item.groupId = 81; });
  const fresh = tabs[3];
  const sync = { autoGroupNewTabs: true, groupingStrategy: 'task' };
  const browser = installBrowser(tabs, { sync, chromeGroups: [{ id: 81, windowId: W, title: 'Coding' }] });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let reached;
  const atGate = new Promise(resolve => { reached = resolve; });
  const query = chrome.tabGroups.query;
  let calls = 0;
  chrome.tabGroups.query = async details => {
    if (++calls < gateAt) return query(details);
    chrome.tabGroups.query = query;
    reached();
    await gate;
    return query(details);
  };
  const { classifier, tracker } = recordingClassifier({ attach: attachNewTab });
  try {
    await tracker.markNew(fresh.id);
    const event = classifier.noteTabUpdated(fresh.id, { status: 'complete' }, { ...fresh }, { autoGroup: true });
    await atGate;
    await during({ classifier, tabs, fresh, sync, browser });
    release();
    await event;
    await classifier.whenIdle();
    await sleep(20);
  } finally {
    classifier.pause();
  }
  return browser.calls.group;
}

test('a cleanup pause or a settings change cancels an Auto-group attach in flight, and whenIdle waits for it', async () => {
  assert.deepEqual(await attachInFlight(240, async () => {}), [{ groupId: 81, tabIds: [24003] }], 'control: an undisturbed attach groups');

  let idle = false;
  const paused = await attachInFlight(241, async ({ classifier }) => {
    classifier.pause();
    classifier.whenIdle().then(() => { idle = true; });
    await sleep(20);
    assert.equal(idle, false, 'whenIdle waits for the attach in flight');
  });
  assert.equal(idle, true);
  assert.deepEqual(paused, [], 'nothing grouped after a cleanup pause');

  const off = await attachInFlight(242, async ({ classifier, sync }) => {
    sync.autoGroupNewTabs = false;
    classifier.invalidate();
  });
  assert.deepEqual(off, [], 'nothing grouped once Auto-group is turned off');

  const offOnly = await attachInFlight(243, async ({ sync }) => { sync.autoGroupNewTabs = false; });
  assert.deepEqual(offOnly, [], 'the setting is re-read before the move');
});

test('an Auto-group attach in flight rechecks the live tab and target group before it moves the tab', async () => {
  const cases = {
    'grouped and dragged out by hand': async ({ classifier, fresh }) => {
      fresh.groupId = 77;
      await classifier.noteTabUpdated(fresh.id, { groupId: 77 }, { ...fresh }, { autoGroup: true });
      fresh.groupId = -1;
      await classifier.noteTabUpdated(fresh.id, { groupId: -1 }, { ...fresh }, { autoGroup: true });
    },
    'navigated to another page': async ({ fresh }) => {
      Object.assign(fresh, { url: 'https://www.elsewhere.com/sourdough', title: 'Sourdough starter' });
    },
    'retitled': async ({ fresh }) => { fresh.title = 'Sourdough starter'; },
    'target group closed': async ({ tabs, browser }) => {
      browser.groups.splice(0, 1);
      tabs.slice(0, 3).forEach(item => { item.groupId = -1; });
    },
    'moved to another window': async ({ fresh }) => { fresh.windowId += 1000; },
    'pinned': async ({ fresh }) => { fresh.pinned = true; },
    'closed': async ({ tabs, fresh }) => { tabs.splice(tabs.indexOf(fresh), 1); }
  };
  let W = 244;
  for (const [label, during] of Object.entries(cases)) {
    assert.deepEqual(await attachInFlight(W++, during), [], label);
  }
});

test('a retitle or navigation delivered while Auto-group queries its target group stops the move', async () => {
  assert.deepEqual(await attachInFlight(180, async () => {}, { gateAt: 2 }), [{ groupId: 81, tabIds: [18003] }], 'control');
  assert.deepEqual(await attachInFlight(181, async ({ fresh }) => { fresh.title = 'Sourdough starter'; }, { gateAt: 2 }), [], 'retitled');
  assert.deepEqual(await attachInFlight(182, async ({ fresh }) => {
    Object.assign(fresh, { url: 'https://www.elsewhere.com/sourdough', title: 'Sourdough starter' });
  }, { gateAt: 2 }), [], 'navigated');
});

test('Auto-group knows a Socials, rules or Review Later group by its members and stored plan, never by its title', async () => {
  const W = 260;
  const page = (id, title, url, groupId = -1) => ({
    id, windowId: W, index: id - 26000, active: false, pinned: false, incognito: false, status: 'complete', groupId, title, url
  });
  const tabs = [
    // The real Socials group, renamed by the user.
    page(26000, 'Kyoto hotel tips | Facebook', 'https://www.facebook.com/groups/kyoto', 61),
    page(26001, 'Kyoto hotel reviews | Facebook', 'https://www.facebook.com/groups/ryokan', 61),
    // A hand-made group that carries the name Socials, with no social member.
    page(26002, 'Garden shed plans', 'https://www.sheds.com/plans', 62),
    page(26003, 'Garden shed roofing', 'https://www.sheds.com/roof', 62),
    // Review Later, renamed by the user; the stored plan knows its members.
    page(26004, 'Sourdough starter hydration', 'https://www.bread.com/a', 63),
    page(26005, 'Sourdough starter feeding', 'https://www.bread.com/b', 63)
  ];
  const browser = installBrowser(tabs, {
    sync: { autoGroupNewTabs: true, groupingStrategy: 'task' },
    chromeGroups: [
      { id: 61, windowId: W, title: 'My Feeds' },
      { id: 62, windowId: W, title: 'Socials' },
      { id: 63, windowId: W, title: 'My Reading Queue' }
    ]
  });
  await WindowPlanStore.put(W, { groups: [{ name: 'Review Later', kind: 'review', tabIds: [26004, 26005] }] });
  const attachLoose = async (id, title, url) => {
    tabs.push(page(id, title, url));
    return (await attachNewTab(id)).groupId ?? null;
  };

  assert.equal(await attachLoose(26010, 'Kyoto hotel deals', 'https://www.travel.com/kyoto'), null,
    'an ordinary tab never joins the renamed Socials group');
  assert.equal(await attachLoose(26011, 'Garden shed tour | Facebook', 'https://www.facebook.com/watch/shed'), 61,
    'a social tab joins the group of social tabs, never a hand-made group that is only called Socials');
  assert.equal(await attachLoose(26012, 'Kyoto hotel offers | Facebook', 'https://www.facebook.com/groups/offers'), 61,
    'a social tab joins the group its social members are in, whatever its name');
  assert.equal(await attachLoose(26013, 'Garden shed foundations', 'https://www.sheds.com/base'), 62,
    'the hand-made group called Socials is an ordinary group');
  assert.equal(await attachLoose(26014, 'Sourdough starter rye', 'https://www.bread.com/c'), null,
    'a renamed Review Later receives no lexical attach');

  // Mixed: a social tab and an ordinary tab together in one hand-made group.
  tabs.push(page(26006, 'Chess openings | Facebook', 'https://www.facebook.com/groups/chess', 64),
    page(26007, 'Chess openings repertoire', 'https://www.chess.com/openings', 64));
  browser.groups.push({ id: 64, windowId: W, title: 'Chess' });
  assert.equal(await attachLoose(26015, 'Chess openings for black', 'https://www.chess.com/black'), null,
    'mixed evidence: left alone');
  assert.equal(await attachLoose(26016, 'Chess club | Facebook', 'https://www.facebook.com/groups/club'), null,
    'mixed evidence: social tabs in two groups, so a social tab is left alone as well');
  assert.deepEqual(browser.calls.group, [{ groupId: 61, tabIds: [26011] }, { groupId: 61, tabIds: [26012] }, { groupId: 62, tabIds: [26013] }]);
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

const QUIET_ENGINES = [
  ['a profile still saved on Gemini Nano', { provider: 'gemini_nano', setupChoice: 'nano', backgroundPrep: true }, true],
  ['Offline smart mode', { provider: 'offline', setupChoice: 'offline', backgroundPrep: true }, true],
  ['Ollama on this device', { provider: 'ollama', setupChoice: 'offline', backgroundPrep: true }, false],
  ['a cloud engine with a key', { provider: 'openai', openaiApiKey: 'test-only', setupChoice: 'cloud', backgroundPrep: true }, false]
];

for (const [label, saved, click] of QUIET_ENGINES) {
  test(`the worker sends and prepares nothing in the background on ${label}`, async () => {
    const W = 226;
    const tabs = makeTopicTabs(W, 22600, { food: 3, travel: 3 });
    const { sync, session, local } = installBrowser(tabs, { sync: { groupingStrategy: 'task', autoGroupNewTabs: true, ...saved } });
    session.foldnex_session_started_v1 = true;
    const listeners = installWorkerEvents();
    const original = globalThis.fetch;
    const fetches = [];
    globalThis.fetch = async url => {
      fetches.push(String(url));
      throw new Error('No request may be sent');
    };
    let promptApi = 0;
    Object.defineProperty(globalThis, 'LanguageModel', { configurable: true, get() { promptApi++; return {}; } });
    const message = body => new Promise(resolve => listeners.message(body, {}, resolve));
    try {
      await import(`../background.js?quiet-${saved.provider}`);
      await listeners.installed({ reason: 'update' });
      await listeners.startup();
      const opened = { ...makeTopicTabs(W, 22680, { travel: 1 })[0], index: tabs.length };
      tabs.push(opened);
      await listeners.tabCreated(opened);
      await listeners.tabUpdated(opened.id, { status: 'complete' }, opened);
      await listeners.tabUpdated(tabs[0].id, { title: 'Ramen recipe, updated' }, { ...tabs[0], title: 'Ramen recipe, updated' });
      // An older popup's preparation request finds no handler and starts nothing.
      assert.equal(listeners.message({ type: 'PREPARE_GROUPING', windowId: W }, {}, () => {}), undefined);
      listeners.storageChanged({ backgroundPrep: { oldValue: false, newValue: true }, autoGroupNewTabs: { oldValue: false, newValue: true } }, 'sync');
      if (click) {
        const result = await message({ type: 'TRIGGER_GROUPING', windowId: W });
        assert.equal(result.success, true);
        assert.equal(result.result.source, 'offline');
        assert.equal(Object.hasOwn(result.result, 'provisionalTabs'), false);
        assert.equal(Object.hasOwn(result.result, 'provisionalInBackground'), false);
      }
      await sleep(1800);
      assert.deepEqual(fetches, []);
      assert.equal(promptApi, 0);
      assert.equal(Object.keys(local).some(key => /label/i.test(key)), false, 'no label is stored');
    } finally {
      globalThis.fetch = original;
      delete globalThis.LanguageModel;
      // The worker's pending work must not reach later tests.
      sync.groupingStrategy = 'site';
    }
  });
}

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

test('the worker refuses a second cleanup as an error and serves and applies a stored plan offer', async () => {
  const W = 228;
  const tabs = makeTopicTabs(W, 22800, { food: 3, travel: 3 });
  const { sync, session } = installBrowser(tabs, { sync: { provider: 'openai', setupChoice: 'cloud' } });
  session.foldnex_session_started_v1 = true;
  const listeners = installWorkerEvents();
  const announced = [];
  chrome.runtime.sendMessage = async message => { announced.push(message); };
  const original = globalThis.fetch;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async (url, options) => {
    await held;
    const user = JSON.parse(options.body).messages.at(-1).content;
    const rows = JSON.parse(user.slice(user.indexOf('{"tabs":'))).tabs;
    const content = JSON.stringify({ folders: [{ name: 'Ramen Nights', ids: rows.slice(0, 3).map(row => row[0]) },
      { name: 'Tokyo Getaway', ids: rows.slice(3).map(row => row[0]) }] });
    return { ok: true, async json() { return { choices: [{ message: { content } }] }; } };
  };
  const message = body => new Promise(resolve => listeners.message(body, {}, resolve));
  try {
    await import('../background.js?plan-offer-messages');
    await chrome.storage.local.set({ openaiApiKey: 'test-only' });

    // A cleanup already running: the second is refused as an error.
    const first = message({ type: 'TRIGGER_GROUPING', windowId: W });
    await sleep(20);
    assert.deepEqual(await message({ type: 'TRIGGER_GROUPING', windowId: W }), { success: false, error: 'Grouping already in progress' });
    release();
    const done = await first;
    assert.equal(done.success, true);
    assert.equal(done.result.source, 'cloud-plan');

    // A stored offer for the unchanged window is served and applied once.
    const groupable = getGroupableTabs(await chrome.tabs.query({ windowId: W }));
    const groups = [{ name: 'Food Plan', color: 'red', tabIds: groupable.slice(0, 3).map(tab => tab.id), kind: 'folder' },
      { name: 'Trip Plan', color: 'blue', tabIds: groupable.slice(3).map(tab => tab.id), kind: 'folder' }];
    // An offer bound to the window as the worker sees it: tab set, engine scope, locked partition and membership.
    const binding = {
      signature: await tabSetSignature(groupable),
      scope: getRunScope(await loadGroupingSettings()).cacheScope,
      locked: lockedPartitionKey((await buildLockedGroups(groupable)).locked),
      membership: groupable.map(tab => [tab.id, Number.isInteger(tab.groupId) ? tab.groupId : -1]).sort((a, b) => a[0] - b[0])
    };
    await PlanOfferStore.put(W, { ...binding, groups }, { epoch: await readResetEpoch() });
    const offered = await message({ type: 'GET_PLAN_OFFER', windowId: W });
    assert.equal(offered.offer.windowId, W);
    const applied = await message({ type: 'APPLY_PLAN_OFFER', windowId: W });
    assert.equal(applied.success, true);
    assert.equal(applied.result.success, true);
    assert.deepEqual(applied.result.groups.map(group => group.name), ['Food Plan', 'Trip Plan']);
    assert.deepEqual(await message({ type: 'GET_PLAN_OFFER', windowId: W }), { ok: true, offer: null });

    // A changed window: the offer is not served.
    await PlanOfferStore.put(W, { ...binding, signature: 'stale', groups }, { epoch: await readResetEpoch() });
    assert.deepEqual(await message({ type: 'GET_PLAN_OFFER', windowId: W }), { ok: true, offer: null });
    assert.equal(await PlanOfferStore.get(W), null);
  } finally {
    globalThis.fetch = original;
    sync.groupingStrategy = 'site';
  }
});

test('the worker serialises Ungroup with cleanup and Apply, cancels a closed window\'s late plan and reports a failed one', async () => {
  const W = 229;
  const tabs = makeTopicTabs(W, 22900, { food: 3, travel: 3 });
  const { sync, session } = installBrowser(tabs, { sync: { provider: 'openai', setupChoice: 'cloud' } });
  session.foldnex_session_started_v1 = true;
  const listeners = installWorkerEvents();
  const announced = [];
  chrome.runtime.sendMessage = async message => { announced.push(message); };
  const original = globalThis.fetch;
  let release;
  let fail = false;
  globalThis.fetch = async (url, options) => {
    await new Promise(resolve => { release = resolve; });
    if (fail) return { ok: false, status: 500, async json() { return { error: { message: 'Upstream failure' } }; } };
    const user = JSON.parse(options.body).messages.at(-1).content;
    const rows = JSON.parse(user.slice(user.indexOf('{"tabs":'))).tabs;
    const content = JSON.stringify({ folders: [{ name: 'Ramen Nights', ids: rows.slice(0, 3).map(row => row[0]) },
      { name: 'Tokyo Getaway', ids: rows.slice(3).map(row => row[0]) }] });
    return { ok: true, async json() { return { choices: [{ message: { content } }] }; } };
  };
  const message = body => new Promise(resolve => listeners.message(body, {}, resolve));
  try {
    await import('../background.js?plan-offer-lock');
    await chrome.storage.local.set({ openaiApiKey: 'test-only' });

    // Ungroup waits its turn: refused while a cleanup holds the lock.
    const cleanup = message({ type: 'TRIGGER_GROUPING', windowId: W });
    await sleep(20);
    assert.deepEqual(await message({ type: 'UNGROUP_ALL' }), { success: false, error: 'Grouping already in progress' });
    // The cleanup misses its deadline (6 s); the plan is still out when the window closes.
    const done = await cleanup;
    assert.equal(done.result.source, 'plan-pending');
    listeners.windowRemoved(W);
    release();
    await sleep(50);
    assert.ok(!announced.some(item => item.type === 'PLAN_OFFER_READY'), 'a closed window gets no offer');
    assert.equal(await PlanOfferStore.get(W), null);

    // A late plan that fails is reported, so the popup stops promising it.
    fail = true;
    tabs.forEach(tab => { tab.title += ' again'; });
    const second = await message({ type: 'TRIGGER_GROUPING', windowId: W });
    assert.equal(second.result.source, 'plan-pending');
    release();
    assert.ok(await waitFor(() => announced.some(item => item.type === 'PLAN_OFFER_FAILED' && item.windowId === W)));
  } finally {
    globalThis.fetch = original;
    sync.groupingStrategy = 'site';
  }
});
