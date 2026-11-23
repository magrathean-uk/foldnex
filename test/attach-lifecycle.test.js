// D34 item 3: an Auto-group attach and a user's Cleanup, Apply or Ungroup.
// A pause invalidates admissions still reading candidates, and each action
// waits (up to 2 s) for a chrome.tabs.group call an attach already issued.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createBackgroundClassifier, createNewTabTracker, NEW_TABS_KEY } from '../src/background-classifier.js';
import { PlanOfferStore, tabSetSignature } from '../src/cache-engine.js';
import { getRunScope, lockedPartitionKey } from '../src/grouper.js';

import { installBrowser, installProvider, makeArea, makeTabs, OPENAI } from './plan-harness.js';

let instance = 0;

test('a pause invalidates an admission still reading its candidates', async () => {
  const reached = Promise.withResolvers();
  const release = Promise.withResolvers();
  const tracker = createNewTabTracker({ area: () => ({
    async get(key) {
      assert.equal(key, NEW_TABS_KEY);
      reached.resolve();
      await release.promise;
      return { [NEW_TABS_KEY]: { fresh: [27], candidates: [27], out: {} } };
    },
    async set() {}
  }) });
  let attachStarts = 0;
  const classifier = createBackgroundClassifier({ tracker, attach: async () => { attachStarts++; return { placed: false }; } });
  const tab = { id: 27, windowId: 2, groupId: -1, title: 'React hooks notes', status: 'complete', url: 'https://react.dev/learn' };
  const event = classifier.noteTabUpdated(tab.id, { status: 'complete' }, tab, { autoGroup: true });
  await reached.promise;
  classifier.pause();
  await classifier.whenIdle();
  classifier.resume();
  release.resolve();
  await event;
  assert.equal(attachStarts, 0, 'the event admitted before the pause starts no attach');
  // A later event for the same candidate is admitted as usual.
  await classifier.noteTabUpdated(tab.id, { title: tab.title }, tab, { autoGroup: true });
  assert.equal(attachStarts, 1);
});

/** The review's worker probe: an attach whose chrome.tabs.group call is already issued. */
async function workerWithIssuedAttach(windowId, { settleAfterMs }) {
  const tabs = makeTabs(windowId, windowId * 10, { count: 8 });
  const { session } = installBrowser(tabs, { liveGroups: true });
  const worker = {};
  const event = name => ({ addListener(listener) { worker[name] = listener; } });
  const settings = { ...OPENAI, autoGroupNewTabs: true, setupChoice: 'cloud' };
  chrome.storage.sync = makeArea(settings);
  chrome.storage.local.setAccessLevel = async () => {};
  chrome.storage.onChanged = event('storageChanged');
  Object.assign(chrome.tabs, { onCreated: event('created'), onUpdated: event('updated'), onRemoved: event('tabRemoved') });
  Object.assign(chrome.tabGroups, { onUpdated: event('groupUpdated'), onRemoved: event('groupRemoved') });
  chrome.action = { onClicked: event('clicked'), async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setPopup() {} };
  chrome.commands = { onCommand: event('command') };
  chrome.runtime = { onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message') };
  chrome.windows = { onRemoved: event('windowRemoved') };
  session.foldnex_session_started_v1 = true;

  const oldGroup = await chrome.tabs.group({ tabIds: [tabs[0].id, tabs[4].id] });
  await chrome.tabGroups.update(oldGroup, { title: 'React' });
  const fresh = { ...tabs[0], id: windowId * 10 + 20, index: tabs.length, title: 'React hooks reference manual',
    url: 'https://sample-new.example/notes', groupId: -1, status: 'loading' };
  tabs.push(fresh);
  const originalGroup = chrome.tabs.group;
  const dispatched = Promise.withResolvers();
  const state = { settled: false };
  chrome.tabs.group = async details => {
    if (!state.gated && details.groupId === oldGroup && details.tabIds[0] === fresh.id) {
      state.gated = true;
      dispatched.resolve();
      if (settleAfterMs !== null) await new Promise(resolve => setTimeout(resolve, settleAfterMs));
      else await new Promise(() => {});
      state.settled = true;
    }
    return originalGroup(details);
  };
  const provider = installProvider();
  await import(`../background.js?attach-lifecycle-${++instance}`);
  await worker.created({ ...fresh });
  fresh.status = 'complete';
  const attach = worker.updated(fresh.id, { status: 'complete' }, { ...fresh });
  await dispatched.promise;
  const message = body => new Promise(resolve => worker.message(body, {}, response => resolve({ response, settled: state.settled })));
  return { tabs, fresh, oldGroup, settings, provider, attach, message };
}

for (const action of ['cleanup', 'apply', 'ungroup']) {
  test(`${action} waits for an Auto-group call already issued before changing membership`, async () => {
    const windowId = { cleanup: 681, apply: 682, ungroup: 683 }[action];
    // Ungroup already waited up to 1 s; its call settles between the old and the new bound.
    const setup = await workerWithIssuedAttach(windowId, { settleAfterMs: action === 'ungroup' ? 1200 : 60 });
    try {
      let reply;
      if (action === 'cleanup') {
        reply = await setup.message({ type: 'TRIGGER_GROUPING', windowId });
        assert.equal(reply.response.result?.source, 'cloud-plan');
      } else if (action === 'apply') {
        const { tabs } = setup;
        await PlanOfferStore.put(windowId, {
          signature: await tabSetSignature(tabs),
          scope: getRunScope(setup.settings).cacheScope,
          locked: lockedPartitionKey([]),
          membership: tabs.map(tab => [tab.id, tab.groupId]).sort((a, b) => a[0] - b[0]),
          groups: [
            { name: 'React Notes', color: 'blue', kind: 'folder', tabIds: tabs.slice(0, 4).map(tab => tab.id) },
            { name: 'Other Topics', color: 'green', kind: 'folder', tabIds: tabs.slice(4).map(tab => tab.id) }
          ]
        });
        reply = await setup.message({ type: 'APPLY_PLAN_OFFER', windowId });
      } else {
        reply = await setup.message({ type: 'UNGROUP_ALL' });
      }
      assert.equal(reply.response.success, true);
      assert.equal(reply.settled, true, 'the issued group call settled before the action answered');
      const placed = setup.fresh.groupId;
      await setup.attach;
      assert.equal(setup.fresh.groupId, placed, 'nothing moves the tab after the action');
      if (action === 'ungroup') assert.equal(placed, -1);
      else assert.notEqual(placed, -1);
    } finally {
      setup.provider.restore();
    }
  });
}

test('cleanup proceeds after 2 s when an issued Auto-group call never settles', async () => {
  const setup = await workerWithIssuedAttach(684, { settleAfterMs: null });
  try {
    const startedAt = Date.now();
    const reply = await setup.message({ type: 'TRIGGER_GROUPING', windowId: 684 });
    assert.equal(reply.response.success, true);
    assert.equal(reply.settled, false);
    assert.ok(Date.now() - startedAt >= 1900, 'it waited for the bound');
  } finally {
    setup.provider.restore();
  }
});
