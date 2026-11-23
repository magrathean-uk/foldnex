// Auto-group places new tabs by the local attach on every engine, through the
// service worker's tab events, and plan engines send nothing in the background.
import assert from 'node:assert/strict';
import test from 'node:test';

import { makeArea, sleep } from './plan-harness.js';

const CODING = 9001;
const TRAVEL = 9002;

function tab(id, windowId, index, title, groupId = -1) {
  return { id, windowId, index, title, groupId, url: `https://www.site-${id}.com/page`, active: false, pinned: false, incognito: false, status: 'complete' };
}

/** Two titled groups and two loose tabs in one window, plus Chrome's worker events. */
function installWorker(windowId, sync) {
  const tabs = [
    tab(windowId * 100 + 1, windowId, 0, 'React hooks reference', CODING),
    tab(windowId * 100 + 2, windowId, 1, 'React hooks rules of hooks', CODING),
    tab(windowId * 100 + 3, windowId, 2, 'React hooks custom hook examples', CODING),
    tab(windowId * 100 + 4, windowId, 3, 'Kyoto hotel deals', TRAVEL),
    tab(windowId * 100 + 5, windowId, 4, 'Kyoto hotel reviews ryokan', TRAVEL),
    tab(windowId * 100 + 6, windowId, 5, 'Kyoto hotel near station', TRAVEL)
  ];
  const groups = [
    { id: CODING, windowId, title: 'Side Project', color: 'blue' },
    { id: TRAVEL, windowId, title: 'Japan Holiday', color: 'green' }
  ];
  const session = { foldnex_session_started_v1: true };
  const calls = { group: [], update: [] };
  const listeners = {};
  const event = name => ({ addListener(listener) { listeners[name] = listener; } });
  globalThis.chrome = {
    storage: {
      local: { ...makeArea({}), async setAccessLevel() {} },
      session: makeArea(session),
      sync: makeArea(sync),
      onChanged: event('storageChanged')
    },
    tabs: {
      async query(query = {}) {
        return tabs
          .filter(item => query.windowId === undefined || item.windowId === query.windowId)
          .filter(item => query.groupId === undefined || item.groupId === query.groupId)
          .map(item => ({ ...item }));
      },
      async get(id) {
        const found = tabs.find(item => item.id === id);
        if (!found) throw new Error(`No tab with id: ${id}`);
        return { ...found };
      },
      async group(details) {
        calls.group.push(JSON.parse(JSON.stringify(details)));
        for (const id of details.tabIds) tabs.find(item => item.id === id).groupId = details.groupId ?? 9999;
        return details.groupId ?? 9999;
      },
      async ungroup() {},
      async remove() {},
      onCreated: event('tabCreated'),
      onUpdated: event('tabUpdated'),
      onRemoved: event('tabRemoved')
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      async query(query = {}) {
        return groups.filter(group => query.windowId === undefined || group.windowId === query.windowId).map(group => ({ ...group }));
      },
      async update(id, details) { calls.update.push({ id, ...details }); },
      onUpdated: event('groupUpdated'),
      onRemoved: event('groupRemoved')
    },
    action: { onClicked: event('actionClicked'), async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setPopup() {} },
    commands: { onCommand: event('command') },
    runtime: { onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message'), openOptionsPage() {} },
    windows: { onRemoved: event('windowRemoved') },
    management: { async getSelf() { return { installType: 'normal' }; } }
  };
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    requests.push(String(url));
    return { ok: false, status: 503, statusText: 'unavailable', async json() { return {}; }, async text() { return ''; } };
  };
  /** A tab opened now: created loading without a title, then complete with one. */
  const open = async (id, title) => {
    const opened = tab(id, windowId, tabs.length, '', -1);
    opened.status = 'loading';
    tabs.push(opened);
    await listeners.tabCreated({ ...opened });
    Object.assign(opened, { status: 'complete', title });
    await listeners.tabUpdated(id, { status: 'complete', title }, { ...opened });
    return opened;
  };
  return { tabs, calls, listeners, requests, open, restore() { globalThis.fetch = original; } };
}

/** Lets the background queue's debounce pass, then stops the worker's background work. */
async function settle(worker, sync) {
  await sleep(1700);
  sync.groupingStrategy = 'site';
  worker.restore();
}

for (const [label, engine] of [
  ['a cloud engine', { provider: 'openai', openaiApiKey: 'test-only' }],
  ['Ollama', { provider: 'ollama' }],
  ['Offline smart mode', { provider: 'offline' }]
]) {
  test(`Auto-group on ${label} attaches a new tab locally or leaves it alone, and sends nothing`, async () => {
    const sync = { ...engine, groupingStrategy: 'task', autoGroupNewTabs: true, setupChoice: 'cloud' };
    const worker = installWorker({ Ollama: 61, 'a cloud engine': 62, 'Offline smart mode': 65 }[label], sync);
    try {
      await import(`../background.js?auto-group-${engine.provider}`);

      const coding = await worker.open(worker.tabs[0].id + 50, 'React hooks testing library guide');
      assert.equal(coding.groupId, CODING);
      const stranger = await worker.open(worker.tabs[0].id + 51, 'Sourdough starter hydration');
      assert.equal(stranger.groupId, -1, 'nothing reaches the threshold: left ungrouped');
      assert.ok(worker.calls.group.every(call => Number.isInteger(call.groupId)), 'no group created');
      assert.deepEqual(worker.calls.update, []);
    } finally {
      await settle(worker, sync);
    }
    assert.deepEqual(worker.requests, [], 'no provider request on a plan engine');
  });
}

test('Auto-group on a profile still saved on Gemini Nano places by the same local attach and never touches the Prompt API', async () => {
  const sync = { provider: 'gemini_nano', groupingStrategy: 'task', autoGroupNewTabs: true, setupChoice: 'nano' };
  const worker = installWorker(63, sync);
  let promptApi = 0;
  Object.defineProperty(globalThis, 'LanguageModel', { configurable: true, get() { promptApi++; return {}; } });
  try {
    await import('../background.js?auto-group-nano');
    const travel = await worker.open(6350, 'Kyoto hotel cheap rooms');
    assert.equal(travel.groupId, TRAVEL);
    const stranger = await worker.open(6351, 'Sourdough starter hydration');
    assert.equal(stranger.groupId, -1);
  } finally {
    await settle(worker, sync);
    delete globalThis.LanguageModel;
  }
  assert.deepEqual(worker.requests, []);
  assert.equal(promptApi, 0);
});
