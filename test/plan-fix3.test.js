// Phase 2 review repairs: upkeep on a full plan, on the live strip, after a
// failed click, and Offline with no free slot.
import assert from 'node:assert/strict';
import test from 'node:test';

import { LearningCache, PlanMemory } from '../src/cache-engine.js';
import { executeTabGrouping } from '../src/grouper.js';

import { installBrowser, installProvider, makeTabs } from './plan-harness.js';

const OPENAI = { provider: 'openai', openaiApiKey: 'test-only', groupingStrategy: 'task' };
const OFFLINE = { provider: 'offline', groupingStrategy: 'task' };

/** A new tab at the end of the strip. */
function addTab(tabs, id, title) {
  const tab = { ...makeTabs(tabs[0].windowId, id, { count: 1 })[0], index: tabs.length, title, url: `https://www.new-${id}.com/page` };
  tabs.push(tab);
  return tab;
}

const FOLDER_NAMES = ['Alpha Project', 'Bravo Reading', 'Charlie Trips', 'Delta Kitchen', 'Echo Music',
  'Foxtrot Garden', 'Golf Lessons', 'Hotel Search', 'India Notes', 'Juliet Shopping'];

test('item 4: a stored plan that fills ten groups keeps them and leaves an unmatched new tab ungrouped, with no request', async () => {
  const W = 701;
  const tabs = makeTabs(W, 70100, { count: 20 });
  installBrowser(tabs);
  const provider = installProvider({
    answer: rows => ({ folders: FOLDER_NAMES.map((name, i) => ({ name, ids: rows.slice(2 * i, 2 * i + 2).map(([id]) => id) })) })
  });
  try {
    const plan = await executeTabGrouping(W, OPENAI);
    assert.equal(plan.source, 'cloud-plan');
    assert.equal(plan.groups.length, 10);

    const stranger = addTab(tabs, 70190, 'Sourdough starter hydration');
    const upkeep = await executeTabGrouping(W, OPENAI);
    assert.equal(provider.requests.length, 1, 'no request for one new tab of 21');
    assert.equal(upkeep.source, 'plan-upkeep');
    assert.equal(upkeep.groups.length, 10, 'no eleventh group');
    assert.deepEqual(upkeep.unplacedTabIds, [stranger.id]);
    assert.equal(stranger.groupId, -1);
  } finally {
    provider.restore();
  }
});

test('item 6: the last model plan survives a failed click, so upkeep still counts against it', async () => {
  const W = 702;
  const tabs = makeTabs(W, 70200, { count: 20 });
  installBrowser(tabs);
  let requests = 0;
  let provider = installProvider();
  try {
    assert.equal((await executeTabGrouping(W, OPENAI)).source, 'cloud-plan');
    requests += provider.requests.length;
    provider.restore();

    addTab(tabs, 70290, 'React hooks reference testing guide');
    addTab(tabs, 70291, 'Kyoto hotel deals near station');
    addTab(tabs, 70292, 'Rust borrow checker lifetimes');
    provider = installProvider({ status: 500 });
    const failed = await executeTabGrouping(W, OPENAI);
    assert.equal(failed.fallbackUsed, true, 'the replacement request failed and the local result was applied');
    requests += provider.requests.length;
    provider.restore();
    assert.equal(requests, 2);

    tabs.splice(tabs.length - 2, 2);
    provider = installProvider();
    const upkeep = await executeTabGrouping(W, OPENAI);
    requests += provider.requests.length;
    assert.equal(requests, 2, 'one new tab of 21 against the last model plan: no request');
    assert.equal(upkeep.source, 'plan-upkeep');
  } finally {
    provider.restore();
  }
});

test('item 7: Offline with ten locked groups makes no eleventh group and reports the rest as ungrouped', async () => {
  const W = 703;
  const tabs = makeTabs(W, 70300, { count: 12 });
  const { local, calls } = installBrowser(tabs);
  await LearningCache.ensureSchema();
  local[LearningCache.STORAGE_KEY] = tabs.slice(0, 10).map((tab, index) => ({
    pattern: `${new URL(tab.url).hostname.replace(/^www\./, '')}/*`,
    category: `Rule ${index}`,
    source: 'manual_rule',
    confidence: 1,
    userOverride: true
  }));
  const result = await executeTabGrouping(W, OFFLINE);
  assert.equal(calls.group.length, 10, 'only the ten locked groups');
  assert.equal(result.groups.length, 10);
  assert.deepEqual(result.unplacedTabIds, [70310, 70311]);
  assert.deepEqual(tabs.slice(10).map(tab => tab.groupId), [-1, -1]);
});

const liveTitle = (browser, tab) => browser.groups.get(tab.groupId)?.title;

test('items 5 and 9: upkeep places only the new tabs into the live groups and keeps hand moves and renames', async () => {
  const W = 704;
  const tabs = makeTabs(W, 70400, { count: 20 });
  const browser = installBrowser(tabs, { liveGroups: true });
  const provider = installProvider();
  try {
    await executeTabGrouping(W, OPENAI);
    const side = tabs[0].groupId;
    const japan = tabs[2].groupId;
    assert.equal(liveTitle(browser, tabs[0]), 'Side Project');
    assert.equal(liveTitle(browser, tabs[2]), 'Japan Holiday');

    // By hand: a coding tab moves to Japan Holiday, another leaves every group.
    tabs[4].groupId = japan;
    tabs[5].groupId = -1;
    const coding = addTab(tabs, 70490, 'React hooks reference testing guide');
    const before = browser.calls.group.length;
    const first = await executeTabGrouping(W, OPENAI);
    assert.equal(first.source, 'plan-upkeep');
    assert.deepEqual(browser.calls.group.slice(before), [{ groupId: side, tabIds: [coding.id] }], 'only the new tab moves, into the live group');
    assert.equal(tabs[4].groupId, japan, 'a hand move stays');
    assert.equal(tabs[5].groupId, -1, 'a tab taken out of every group stays out');
    assert.equal(coding.groupId, side);

    // An unrelated tab starts Review Later; the user renames it.
    const stranger = addTab(tabs, 70491, 'Sourdough starter hydration');
    await executeTabGrouping(W, OPENAI);
    const review = stranger.groupId;
    assert.ok(review !== -1 && review !== side && review !== japan);
    browser.groups.get(review).title = 'My Reading Queue';
    const members = tabs.filter(tab => tab.groupId === review);
    await LearningCache.learnGroupRename(members, 'My Reading Queue', 'grey');
    await PlanMemory.recordUserRename({ tabs: members, name: 'My Reading Queue', color: 'grey', keys: ['review'] });

    // Another unrelated tab joins the renamed Review Later, which keeps its name
    // (the coding tab is closed, so two of 22 tabs are new).
    tabs.splice(tabs.indexOf(coding), 1);
    const another = addTab(tabs, 70492, 'Bicycle chain lubricant');
    const updates = browser.calls.update.length;
    const third = await executeTabGrouping(W, OPENAI);
    assert.equal(third.source, 'plan-upkeep');
    assert.equal(another.groupId, review);
    assert.equal(stranger.groupId, review);
    assert.equal(browser.groups.get(review).title, 'My Reading Queue');
    assert.deepEqual(browser.calls.update.slice(updates), [], 'no group renamed or recreated');
    assert.equal(new Set(tabs.map(tab => tab.groupId).filter(id => id !== -1)).size, 3, 'no duplicate group');
    assert.equal(provider.requests.length, 1);

    // After Ungroup, the stored groups come back and the new tab is placed.
    tabs.forEach(tab => { tab.groupId = -1; });
    tabs.splice(tabs.indexOf(another), 1);
    const restored = await executeTabGrouping(W, OPENAI);
    assert.equal(restored.source, 'plan-upkeep');
    assert.notEqual(stranger.groupId, -1);
    assert.equal(tabs[0].groupId, tabs[1].groupId);
    assert.notEqual(tabs[0].groupId, -1);
    assert.equal(provider.requests.length, 1);
  } finally {
    provider.restore();
  }
});
