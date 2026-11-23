// Phase 2 confirmation repairs: upkeep when the cap binds, after a drag-out,
// against a hand move during placement, and on a strip without plan groups.
import assert from 'node:assert/strict';
import test from 'node:test';

import { executeTabGrouping } from '../src/grouper.js';

import { installBrowser, installProvider, makeTabs } from './plan-harness.js';

const OPENAI = { provider: 'openai', openaiApiKey: 'test-only', groupingStrategy: 'task' };

/** A new tab at the end of the strip. */
function addTab(tabs, id, title, url = `https://www.new-${id}.com/page`) {
  const tab = { ...makeTabs(tabs[0].windowId, id, { count: 1 })[0], index: tabs.length, title, url };
  tabs.push(tab);
  return tab;
}

const FOLDER_NAMES = ['Alpha Project', 'Bravo Reading', 'Charlie Trips', 'Delta Kitchen', 'Echo Music',
  'Foxtrot Garden', 'Golf Lessons', 'Hotel Search', 'India Notes', 'Juliet Shopping'];
const tenFolders = rows => ({ folders: FOLDER_NAMES.map((name, i) => ({ name, ids: rows.slice(2 * i, 2 * i + 2).map(([id]) => id) })) });
const groupsOnStrip = tabs => new Set(tabs.map(tab => tab.groupId).filter(id => id !== -1));

test('when the cap binds, upkeep stays local and leaves an unmatched tab and a Socials tab ungrouped', async () => {
  const W = 801;
  const tabs = makeTabs(W, 80100, { count: 20 });
  installBrowser(tabs, { liveGroups: true });
  const provider = installProvider({ answer: tenFolders });
  try {
    assert.equal((await executeTabGrouping(W, OPENAI)).groups.length, 10);
    const stranger = addTab(tabs, 80190, 'Sourdough starter hydration');
    const social = addTab(tabs, 80191, 'Friends feed', 'https://www.facebook.com/feed');
    const upkeep = await executeTabGrouping(W, OPENAI);
    assert.equal(provider.requests.length, 1, 'no request: 1 new tab of 21 unlocked');
    assert.equal(upkeep.source, 'plan-upkeep');
    assert.deepEqual([...upkeep.unplacedTabIds].sort(), [stranger.id, social.id]);
    assert.deepEqual([stranger.groupId, social.groupId], [-1, -1]);
    assert.equal(groupsOnStrip(tabs).size, 10, 'no eleventh group');

    // With an empty strip the stored groups return, still within ten groups.
    tabs.forEach(tab => { tab.groupId = -1; });
    const another = addTab(tabs, 80192, 'Bicycle chain lubricant');
    const restored = await executeTabGrouping(W, OPENAI);
    assert.equal(provider.requests.length, 1);
    assert.equal(restored.source, 'plan-upkeep');
    assert.equal(groupsOnStrip(tabs).size, 10, 'no eleventh group after Ungroup');
    assert.deepEqual([stranger.groupId, social.groupId, another.groupId], [-1, -1, -1]);
  } finally {
    provider.restore();
  }
});

test('a tab an earlier upkeep placed and the user dragged out is not placed again', async () => {
  const W = 802;
  const tabs = makeTabs(W, 80200, { count: 20 });
  installBrowser(tabs, { liveGroups: true });
  const provider = installProvider();
  try {
    await executeTabGrouping(W, OPENAI);
    const side = tabs[0].groupId;
    const coding = addTab(tabs, 80290, 'React hooks reference testing guide');
    await executeTabGrouping(W, OPENAI);
    assert.equal(coding.groupId, side, 'the first upkeep places it');

    coding.groupId = -1;
    const stranger = addTab(tabs, 80291, 'Sourdough starter hydration');
    const second = await executeTabGrouping(W, OPENAI);
    assert.equal(second.source, 'plan-upkeep');
    assert.equal(provider.requests.length, 1);
    assert.equal(coding.groupId, -1, 'the dragged-out tab stays out');
    assert.notEqual(stranger.groupId, -1, 'the other new tab is still placed');
  } finally {
    provider.restore();
  }
});

test('a new tab grouped by hand while upkeep reads the groups is left where the user put it', async () => {
  const W = 803;
  const tabs = makeTabs(W, 80300, { count: 20 });
  installBrowser(tabs, { liveGroups: true });
  const provider = installProvider();
  try {
    await executeTabGrouping(W, OPENAI);
    const japan = tabs[2].groupId;
    const coding = addTab(tabs, 80390, 'React hooks reference testing guide');
    const query = chrome.tabGroups.query;
    chrome.tabGroups.query = async details => {
      chrome.tabGroups.query = query;
      coding.groupId = japan;
      return query(details);
    };
    const upkeep = await executeTabGrouping(W, OPENAI);
    assert.equal(upkeep.source, 'plan-upkeep');
    assert.equal(coding.groupId, japan, 'the hand move stays');
  } finally {
    provider.restore();
  }
});

test('upkeep reapplies the stored groups only on an empty strip; one unrelated group keeps the old tabs loose', async () => {
  const W = 804;
  const tabs = makeTabs(W, 80400, { count: 20 });
  const browser = installBrowser(tabs, { liveGroups: true });
  const provider = installProvider({ answer: tenFolders });
  try {
    await executeTabGrouping(W, OPENAI);
    tabs.forEach(tab => { tab.groupId = -1; });
    const mine = addTab(tabs, 80490, 'Sourdough starter hydration');
    browser.groups.set(9000, { id: 9000, windowId: W, title: 'Mine', color: 'red' });
    mine.groupId = 9000;
    const upkeep = await executeTabGrouping(W, OPENAI);
    assert.equal(provider.requests.length, 1);
    assert.equal(upkeep.source, 'plan-upkeep');
    assert.deepEqual([...groupsOnStrip(tabs)], [9000], 'no stored group recreated');
    assert.ok(tabs.slice(0, 20).every(tab => tab.groupId === -1));
  } finally {
    provider.restore();
  }
});
