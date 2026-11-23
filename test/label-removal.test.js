// Phase 4: the per-tab label pipeline is gone. These pin the places where
// live code leaned on it: the Offline click, the plan path's fingerprints,
// remembered names on a cached result, the background module, the engine
// scopes stored data is keyed by, and the clean-up of its storage on update.
import assert from 'node:assert/strict';
import test from 'node:test';

import { labelCacheScope } from '../src/ai-engine.js';
import { createBackgroundClassifier } from '../src/background-classifier.js';
import { ExactResultCache, LearningCache, PlanMemory } from '../src/cache-engine.js';
import * as grouper from '../src/grouper.js';
import { planLocally } from '../src/local-engine.js';

import { installBrowser, installProvider, makeArea, makeTabs, membership, OPENAI } from './plan-harness.js';

const { executeTabGrouping, getRunScope } = grouper;
const OFFLINE = { provider: 'offline', groupingStrategy: 'task' };
const LABEL_CACHE_KEY = 'foldnex_tab_labels_v1';

/** Record every key read from storage.local. */
function watchReads(area) {
  const reads = [];
  const get = area.get.bind(area);
  area.get = async keys => {
    reads.push(...(keys === undefined || keys === null ? ['*'] : Array.isArray(keys) ? keys : [keys]));
    return get(keys);
  };
  return reads;
}

test('the engine scopes that stored plans and remembered names are keyed by keep their values', () => {
  const cases = [
    [{ provider: 'openai' }, 'labels-v2:openai:c257ac56:764509af', 'plan-v1-window:task:labels-v2:openai:52b02614:764509af:plan'],
    [{ provider: 'offline' }, 'labels-v2:offline:489c616e:ec8b9928', 'plan-v1-window:task:labels-v2:offline:489c616e:ec8b9928:local-v1'],
    [{ provider: 'ollama' }, 'labels-v2:ollama:8d8c8603:3ee294ed', 'plan-v1-window:task:labels-v2:ollama:8d8c8603:3ee294ed:plan'],
    [{ provider: 'gemini_api', geminiModel: 'gemini-2.5-flash' }, 'labels-v2:gemini_api:acef57f5:6a5d0ddd', 'plan-v1-window:task:labels-v2:gemini_api:acef57f5:6a5d0ddd:plan'],
    [{ provider: 'groq', groqModel: 'openai/gpt-oss-20b', groqReasoningEffort: 'high' }, 'labels-v2:groq:a412e9fd:2fa48d57', 'plan-v1-window:task:labels-v2:groq:cb23f03f:2fa48d57:plan'],
    [{ provider: 'openrouter', openrouterBaseUrl: 'https://openrouter.ai/api/v1/?k=1#x' }, 'labels-v2:openrouter:3c4ed381:ed886766', 'plan-v1-window:task:labels-v2:openrouter:3c4ed381:ed886766:plan']
  ];
  for (const [settings, scope, cacheScope] of cases) {
    assert.equal(labelCacheScope(settings), scope);
    const run = getRunScope({ ...settings, groupingStrategy: 'task' });
    assert.equal(run.labelScope, scope);
    assert.equal(run.cacheScope, cacheScope);
  }
  assert.equal('acceptEnginesFor' in grouper, false, 'the label cache\'s engine filter went with it');
});

test('an Offline click runs the local engine on the window directly and reads no label cache', async () => {
  assert.equal('groupByLabels' in grouper, false);
  const W = 9101;
  const tabs = makeTabs(W, 910100, { count: 12 });
  const { local } = installBrowser(tabs);
  const reads = watchReads(chrome.storage.local);

  const result = await executeTabGrouping(W, OFFLINE);
  assert.equal(result.source, 'offline');
  assert.equal(result.localEmbedding, 'words');
  assert.equal(reads.includes(LABEL_CACHE_KEY), false);
  assert.equal(LABEL_CACHE_KEY in local, false);

  const tabsById = new Map(tabs.map(tab => [tab.id, tab]));
  const expected = planLocally(tabs, { locked: [], tabsById, vectors: null, memory: { names: [] }, fingerprintById: new Map() });
  assert.deepEqual(membership(result.groups), membership(expected.groups));
  assert.deepEqual(result.groups.map(group => group.name).sort(), expected.groups.map(group => group.name).sort());
});

test('a plan click fingerprints its tabs without the label cache, and a user rename still names its folder', async () => {
  const W = 9102;
  const tabs = makeTabs(W, 910200, { count: 8 });
  installBrowser(tabs);
  const coding = tabs.filter(tab => /react|rust/i.test(tab.title));
  await PlanMemory.recordUserRename({ tabs: coding, name: 'Weekend Hacks', color: 'red', keys: [] });
  const reads = watchReads(chrome.storage.local);
  const provider = installProvider();
  try {
    const result = await executeTabGrouping(W, OPENAI);
    assert.equal(result.source, 'cloud-plan');
    assert.equal(provider.requests.length, 1);
    assert.equal(reads.includes(LABEL_CACHE_KEY), false);
    const named = result.groups.find(group => group.tabIds.includes(coding[0].id));
    assert.equal(named.name, 'Weekend Hacks');
    assert.equal(named.color, 'red');
  } finally {
    provider.restore();
  }
});

test('on a repeat click served from the exact cache, a group the user renamed keeps the name, with no request', async () => {
  const W = 9103;
  const tabs = makeTabs(W, 910300, { count: 8 });
  installBrowser(tabs);
  const provider = installProvider();
  try {
    const first = await executeTabGrouping(W, OPENAI);
    assert.equal(first.source, 'cloud-plan');
    const coding = tabs.filter(tab => /react|rust/i.test(tab.title));
    assert.equal(first.groups.find(group => group.tabIds.includes(coding[0].id)).name, 'Side Project');

    // The rename as the worker records it from the tab strip.
    await PlanMemory.recordUserRename({ tabs: coding, name: 'Weekend Hacks', color: 'red', keys: [] });
    const reads = watchReads(chrome.storage.local);
    const repeat = await executeTabGrouping(W, OPENAI);
    assert.equal(repeat.source, 'exact-cache');
    assert.equal(provider.requests.length, 1, 'no second request');
    assert.equal(reads.includes(LABEL_CACHE_KEY), false);
    const renamed = repeat.groups.find(group => group.tabIds.includes(coding[0].id));
    assert.equal(renamed.name, 'Weekend Hacks');
    assert.equal(renamed.color, 'red');
    assert.deepEqual(membership(repeat.groups), membership(first.groups), 'the cached membership is kept');
    assert.equal(repeat.groups.find(group => group !== renamed).name, 'Japan Holiday');
  } finally {
    provider.restore();
  }
});

// D34 item 2: a renamed travel group that took in three coding tabs half-overlaps
// the larger coding group too. The rename belongs to the travel cohort it matches best.
for (const method of ['exact', 'stored']) {
  test(`a rename of a group with dragged-in tabs stays on its own cohort on a repeat click (${method})`, async () => {
    const W = method === 'exact' ? 9105 : 9106;
    const tabs = makeTabs(W, W * 100, { count: 11 });
    const { local } = installBrowser(tabs, { liveGroups: true });
    const provider = installProvider();
    try {
      const first = await executeTabGrouping(W, OPENAI);
      const coding = first.groups.find(group => group.name === 'Side Project');
      const travel = first.groups.find(group => group.name === 'Japan Holiday');
      assert.deepEqual([coding.tabIds.length, travel.tabIds.length], [6, 5]);
      const travelGroupId = tabs.find(tab => tab.id === travel.tabIds[0]).groupId;
      await chrome.tabs.group({ groupId: travelGroupId, tabIds: coding.tabIds.slice(0, 3) });
      const renamed = tabs.filter(tab => tab.groupId === travelGroupId);
      assert.equal(renamed.length, 8);
      if (method === 'stored') {
        await LearningCache.learnGroupRename(renamed, 'Tokyo Itinerary', 'pink');
        assert.equal(ExactResultCache.STORAGE_KEY in local, false, 'the rename cleared the exact result');
      }
      await PlanMemory.recordUserRename({ tabs: renamed, name: 'Tokyo Itinerary', color: 'pink', keys: travel.keys });
      const repeat = await executeTabGrouping(W, OPENAI);
      assert.equal(repeat.source, method === 'exact' ? 'exact-cache' : 'stored-plan');
      assert.equal(provider.requests.length, 1, 'no second request');
      assert.deepEqual(membership(repeat.groups), membership(first.groups));
      const byFirstTab = id => repeat.groups.find(group => group.tabIds.includes(id));
      assert.deepEqual([byFirstTab(travel.tabIds[0]).name, byFirstTab(travel.tabIds[0]).color], ['Tokyo Itinerary', 'pink']);
      assert.deepEqual([byFirstTab(coding.tabIds[0]).name, byFirstTab(coding.tabIds[0]).color], ['Side Project', coding.color]);
    } finally {
      provider.restore();
    }
  });
}

test('the background module only tracks new tabs for Auto-group and its lifecycle; tab events queue nothing else', async () => {
  const session = {};
  const attached = [];
  const classifier = createBackgroundClassifier({
    tracker: undefined,
    attach: async tabId => { attached.push(tabId); return { placed: true }; }
  });
  assert.deepEqual(Object.keys(classifier).sort(), [
    'clear', 'invalidate', 'noteTabCreated', 'noteTabRemoved', 'noteTabUpdated',
    'noteWindowUngrouped', 'pause', 'resume', 'setAutoGroup', 'whenIdle'
  ]);
  globalThis.chrome = { storage: { session: makeArea(session), local: makeArea({}), sync: makeArea({}) } };

  const tab = { id: 5, windowId: 1, groupId: -1, status: 'loading', url: 'https://example.com/a', title: '' };
  await classifier.noteTabCreated(tab, { autoGroup: false });
  await classifier.noteTabUpdated(5, { status: 'complete', title: 'Example' }, { ...tab, status: 'complete', title: 'Example' }, { autoGroup: false });
  assert.deepEqual(attached, [], 'Auto-group off: nothing is attached');

  await classifier.noteTabCreated({ ...tab, id: 6 }, { autoGroup: true });
  await classifier.noteTabUpdated(6, { status: 'complete', title: 'Example' }, { ...tab, id: 6, status: 'complete', title: 'Example' }, { autoGroup: true });
  assert.deepEqual(attached, [6], 'a new tab is attached locally once it has loaded');
  await classifier.whenIdle();
  await classifier.clear({ waitMs: 50 });
});

test('an update removes the label cache and the retired economy setting once, and old remembered names stay readable', async () => {
  const now = Date.now();
  const stored = {
    [LABEL_CACHE_KEY]: { v: 'v2', g: 0, entries: { abc: { c: 'food', t: now, e: 'openai' } } },
    foldnex_plan_memory_v1: {
      v: 1,
      g: 0,
      names: [
        { k: ['food'], w: ['0a1b2c3d'], n: 'Weeknight Cooking', c: 'orange', s: 'cloud', t: now },
        { k: ['travel'], w: ['0a1b2c3e'], n: 'Kyoto Trip', c: 'blue', s: 'nano', t: now }
      ],
      advice: { cloud: {}, t: 0 }
    }
  };
  const sync = { provider: 'openai', cloudEconomyMode: true, autoGroupNewTabs: true };
  const listeners = {};
  const event = name => ({ addListener(listener) { listeners[name] = listener; } });
  const syncWrites = [];
  globalThis.chrome = {
    storage: {
      local: { ...makeArea(stored), async setAccessLevel() {} },
      session: makeArea({}),
      sync: makeArea(sync, syncWrites),
      onChanged: event('storageChanged')
    },
    action: { onClicked: event('actionClicked'), async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setPopup() {} },
    commands: { onCommand: event('command') },
    runtime: { onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message'), openOptionsPage() {} },
    tabs: { onUpdated: event('tabUpdated'), async query() { return []; } },
    tabGroups: { onUpdated: event('groupUpdated'), onRemoved: event('groupRemoved'), async query() { return []; } },
    windows: { onRemoved: event('windowRemoved') },
    management: { async getSelf() { return { installType: 'normal' }; } }
  };
  await import('../background.js');
  await listeners.installed({ reason: 'update' });

  assert.equal(LABEL_CACHE_KEY in stored, false);
  assert.equal('cloudEconomyMode' in sync, false);
  assert.equal(sync.provider, 'openai');
  assert.equal(sync.autoGroupNewTabs, true);
  const memory = await PlanMemory.read();
  assert.deepEqual(memory.names.map(record => [record.n, record.s]).sort(), [['Kyoto Trip', 'nano'], ['Weeknight Cooking', 'cloud']]);

  const writes = syncWrites.length;
  await listeners.installed({ reason: 'update' });
  assert.equal(syncWrites.length, writes, 'a second run finds nothing to change');
});
