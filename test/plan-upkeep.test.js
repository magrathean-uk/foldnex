// Plan upkeep: a click on a window with a stored model plan and at most 10%
// new tabs attaches them locally and sends no request.
import assert from 'node:assert/strict';
import test from 'node:test';

import { LearningCache, PlanMemory, PlanOfferStore, WindowPlanStore } from '../src/cache-engine.js';
import { executeTabGrouping } from '../src/grouper.js';

import { installBrowser, installProvider, makeTabs, membership, OPENAI } from './plan-harness.js';

/** A new tab at the end of the strip. */
function addTab(tabs, id, title) {
  const tab = { ...makeTabs(tabs[0].windowId, id, { count: 1 })[0], index: tabs.length, title, url: `https://www.new-${id}.com/page` };
  tabs.push(tab);
  return tab;
}

const groupOf = (result, id) => result.groups.find(group => group.tabIds.includes(id));
const without = (groups, ids) => membership(groups.map(group => ({ tabIds: group.tabIds.filter(id => !ids.includes(id)) })).filter(group => group.tabIds.length));

test('one new tab of twenty joins a plan group or Review Later with no request, and a repeat click sends nothing', async () => {
  const W = 501;
  const tabs = makeTabs(W, 50100, { count: 20 });
  installBrowser(tabs, { liveGroups: true });
  const provider = installProvider();
  try {
    const plan = await executeTabGrouping(W, OPENAI);
    assert.equal(plan.source, 'cloud-plan');
    assert.equal(provider.requests.length, 1);

    const coding = addTab(tabs, 50190, 'React hooks reference testing guide');
    const upkeep = await executeTabGrouping(W, OPENAI);
    assert.equal(provider.requests.length, 1, 'no request for one new tab');
    assert.equal(upkeep.source, 'plan-upkeep');
    assert.equal(upkeep.upkeepAttached, 1);
    assert.equal(groupOf(upkeep, coding.id).name, 'Side Project');
    assert.deepEqual(without(upkeep.groups, [coding.id]), membership(plan.groups), 'plan groups kept');
    const run = (await chrome.storage.local.get('foldnex_last_run')).foldnex_last_run;
    assert.equal(run.source, 'plan-upkeep');
    assert.ok(Object.values(run.modelCalls).every(count => count === 0), 'no model call recorded');
    assert.equal(run.reasoningEffort, null);

    const repeat = await executeTabGrouping(W, OPENAI);
    assert.equal(provider.requests.length, 1, 'a repeat click on the unchanged window sends nothing');
    assert.deepEqual(membership(repeat.groups), membership(upkeep.groups));

    // A stranger goes to Review Later; the plan's groups stay as they were.
    const stranger = addTab(tabs, 50191, 'Sourdough starter hydration');
    const second = await executeTabGrouping(W, OPENAI);
    assert.equal(provider.requests.length, 1);
    assert.equal(second.source, 'plan-upkeep');
    assert.equal(groupOf(second, stranger.id).kind, 'review');
    assert.equal(groupOf(second, coding.id).name, 'Side Project');
  } finally {
    provider.restore();
  }
});

test('past 10% new tabs (a changed title counts) the click requests a new plan', async () => {
  const W = 502;
  const tabs = makeTabs(W, 50200, { count: 20 });
  installBrowser(tabs);
  const provider = installProvider();
  try {
    await executeTabGrouping(W, OPENAI);
    addTab(tabs, 50290, 'React hooks reference testing guide');
    addTab(tabs, 50291, 'Kyoto hotel deals near station');
    tabs[3].title = 'Kyoto ryokan with onsen';
    const result = await executeTabGrouping(W, OPENAI);
    assert.equal(provider.requests.length, 2);
    assert.equal(result.source, 'cloud-plan');
  } finally {
    provider.restore();
  }
});

test('new tabs accumulate against the last model plan across upkeep clicks; closed tabs drop out', async () => {
  const W = 503;
  const tabs = makeTabs(W, 50300, { count: 20 });
  installBrowser(tabs);
  const provider = installProvider();
  try {
    await executeTabGrouping(W, OPENAI);
    const closed = tabs.splice(5, 1)[0];
    addTab(tabs, 50390, 'React hooks reference testing guide');
    const first = await executeTabGrouping(W, OPENAI);
    assert.equal(first.source, 'plan-upkeep');
    assert.ok(!first.groups.some(group => group.tabIds.includes(closed.id)), 'a closed tab drops out');

    addTab(tabs, 50391, 'Cheap flights to Tokyo in spring');
    const second = await executeTabGrouping(W, OPENAI);
    assert.equal(second.source, 'plan-upkeep', '2 new of 20 is within 10%');
    assert.equal(provider.requests.length, 1);

    addTab(tabs, 50392, 'Rust borrow checker lifetimes');
    const third = await executeTabGrouping(W, OPENAI);
    assert.equal(third.source, 'cloud-plan', '3 new since the model plan is past 10%');
    assert.equal(provider.requests.length, 2);
  } finally {
    provider.restore();
  }
});

test('a group the user renamed keeps its name through upkeep', async () => {
  const W = 504;
  const tabs = makeTabs(W, 50400, { count: 20 });
  const browser = installBrowser(tabs, { liveGroups: true });
  const provider = installProvider();
  try {
    const plan = await executeTabGrouping(W, OPENAI);
    const coding = plan.groups.find(group => group.name === 'Side Project');
    // The user renames the group in Chrome, and the worker records it.
    const members = tabs.filter(tab => coding.tabIds.includes(tab.id));
    browser.groups.get(members[0].groupId).title = 'Weekend Code';
    await LearningCache.learnGroupRename(members, 'Weekend Code', 'purple');
    await PlanMemory.recordUserRename({ tabs: members, name: 'Weekend Code', color: 'purple', keys: coding.keys || [] });

    const added = addTab(tabs, 50490, 'React hooks reference testing guide');
    const upkeep = await executeTabGrouping(W, OPENAI);
    assert.equal(provider.requests.length, 1);
    assert.equal(upkeep.source, 'plan-upkeep');
    assert.equal(groupOf(upkeep, added.id).name, 'Weekend Code');
  } finally {
    provider.restore();
  }
});

test('an incognito window gets no upkeep and stores nothing', async () => {
  const W = 505;
  const tabs = makeTabs(W, 50500, { count: 20, incognito: true });
  const { local, session } = installBrowser(tabs);
  const provider = installProvider();
  const isPlanState = key => key.startsWith(WindowPlanStore.KEY_PREFIX) || key.startsWith(PlanOfferStore.KEY_PREFIX);
  try {
    await executeTabGrouping(W, OPENAI);
    addTab(tabs, 50590, 'React hooks reference testing guide').incognito = true;
    const result = await executeTabGrouping(W, OPENAI);
    assert.equal(provider.requests.length, 0, 'a private click sends nothing');
    assert.equal(result.source, 'offline');
    assert.deepEqual(local, {});
    assert.ok(!Object.keys(session).some(isPlanState));
  } finally {
    provider.restore();
  }
});
