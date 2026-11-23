import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_GROUPS, planOutputBudget, requestProviderJson } from '../src/ai-engine.js';
import { ExactResultCache, LearningCache, PlanOfferStore, WindowPlanStore } from '../src/cache-engine.js';
import { applyPlanOffer, cancelPlanWork, executeTabGrouping, getPlanOffer } from '../src/grouper.js';
import { enforcePlan, validateGroupName } from '../src/planner.js';

import { installBrowser, installProvider, makeTabs, membership, OPENAI, sleep, topicFolders, waitFor } from './plan-harness.js';

// Regression tests for the Phase 1 review (2026-11-22). Each test names the
// review finding it covers.

const LATE = { budgetMs: 300 };

/** Run a late click and wait until its plan is offered. */
async function lateOffer(windowId, settings = OPENAI, options = {}) {
  const offers = [];
  const result = await executeTabGrouping(windowId, settings, { ...LATE, onPlanOffer: id => offers.push(id), ...options });
  assert.equal(result.source, 'plan-pending');
  assert.ok(await waitFor(async () => offers.length > 0 && Boolean(await PlanOfferStore.get(windowId))), 'the late plan is offered');
  return { result, offers };
}

function addRule(local, host, category) {
  const rules = local[LearningCache.STORAGE_KEY] || [];
  local[LearningCache.STORAGE_KEY] = [...rules, { pattern: `${host}/*`, category, source: 'manual_rule', confidence: 1, userOverride: true }];
}

test('finding 1: a schema rejection falls back locally with no second request, and the next plan goes out in JSON mode', async () => {
  const tabs = makeTabs(501, 50100);
  installBrowser(tabs);
  const settings = { ...OPENAI, openaiModel: 'gpt-5.4-mini' };
  const original = globalThis.fetch;
  const formats = [];
  globalThis.fetch = async (url, { body }) => {
    const payload = JSON.parse(body);
    formats.push(payload.response_format.type);
    if (payload.response_format.type === 'json_schema') {
      return { ok: false, status: 400, async json() { return { error: { message: 'Unsupported response_format', param: 'response_format' } }; } };
    }
    const user = payload.messages.at(-1).content;
    const rows = JSON.parse(user.slice(user.indexOf('{"tabs":'))).tabs;
    return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify(topicFolders(rows)) } }] }; } };
  };
  try {
    const first = await executeTabGrouping(501, settings);
    assert.deepEqual(formats, ['json_schema'], 'the click sends one request');
    assert.equal(first.source, 'offline-fallback');
    assert.equal(first.fallbackUsed, true);

    const second = await executeTabGrouping(501, settings);
    assert.deepEqual(formats, ['json_schema', 'json_object'], 'the next plan request uses JSON mode');
    assert.equal(second.source, 'cloud-plan');

    // A label caller keeps its single JSON-mode retry.
    formats.length = 0;
    await requestProviderJson({ ...settings, openaiModel: 'gpt-5.4-nano' }, {
      system: 'label', user: '{"tabs":[]}', jsonSchema: { type: 'object', properties: {}, additionalProperties: false }
    });
    assert.deepEqual(formats, ['json_schema', 'json_object']);
  } finally {
    globalThis.fetch = original;
  }
});

test('finding 2: the plan uses the lowest effort the model supports and a bounded budget, and reports the effort sent', async () => {
  const cases = [
    // [settings, tabs, expected effort, expected budget]
    [{ ...OPENAI, openaiModel: 'gpt-6-luna', openaiReasoningEffort: 'max' }, 8, 'none', planOutputBudget(8)],
    [{ ...OPENAI, openaiModel: 'gpt-5.5', openaiReasoningEffort: 'high' }, 8, 'low', planOutputBudget(8) + 2048],
    [{ ...OPENAI, openaiModel: 'gpt-5.5', openaiReasoningEffort: 'high' }, 200, 'low', planOutputBudget(200) + 2048],
    [{ ...OPENAI, openaiModel: 'gpt-5.5' }, 700, 'low', 8192]
  ];
  let windowId = 502;
  for (const [settings, count, effort, budget] of cases) {
    windowId++;
    const tabs = makeTabs(windowId, windowId * 1000, { count });
    installBrowser(tabs);
    const provider = installProvider();
    try {
      const result = await executeTabGrouping(windowId, settings);
      assert.equal(provider.requests.length, 1);
      const { payload } = provider.requests[0];
      assert.equal(payload.reasoning_effort, effort, `${settings.openaiModel} ${count}`);
      assert.equal(payload.max_completion_tokens, budget, `${settings.openaiModel} ${count}`);
      assert.equal(result.reasoningEffort, effort);
      const run = (await chrome.storage.local.get('foldnex_last_run')).foldnex_last_run;
      assert.equal(run.reasoningEffort, effort);
    } finally {
      provider.restore();
    }
  }
});

test('finding 3: an answer that lands after the deadline is late even while local work is still busy', async () => {
  const tabs = makeTabs(510, 51000);
  installBrowser(tabs);
  const provider = installProvider({ delayMs: 400 });
  const get = chrome.storage.local.get;
  chrome.storage.local.get = async keys => {
    if (Array.isArray(keys) ? keys.includes('foldnex_plan_memory_v1') : keys === 'foldnex_plan_memory_v1') await sleep(600);
    return get(keys);
  };
  try {
    const result = await executeTabGrouping(510, OPENAI, { budgetMs: 700 });
    assert.equal(result.source, 'plan-pending');
    assert.equal(result.deadlineHit, true);
  } finally {
    provider.restore();
  }
});

test('finding 4: a late request is only offered; a repeat click on reordered tabs sends nothing and applies nothing', async () => {
  const tabs = makeTabs(511, 51100);
  const { calls } = installBrowser(tabs);
  const provider = installProvider({ delayMs: 400 });
  const offers = [];
  try {
    const first = await executeTabGrouping(511, OPENAI, { ...LATE, onPlanOffer: id => offers.push(id) });
    assert.equal(first.source, 'plan-pending');
    const localGroups = calls.group.length;
    tabs.reverse();
    tabs.forEach((tab, index) => { tab.index = index; });
    const second = await executeTabGrouping(511, OPENAI);
    assert.equal(provider.requests.length, 1, 'the late request is not sent again');
    assert.equal(second.source, 'plan-pending');
    assert.equal(second.planPending, true);
    assert.equal(calls.group.length, localGroups, 'the strip is left as it is');
    assert.ok(await waitFor(() => offers.length === 1));
    assert.equal(calls.group.length, localGroups, 'a late answer is never applied without Apply');

    // The offer keeps the ordinal mapping of the request that was sent.
    const applied = await applyPlanOffer(511, OPENAI);
    assert.equal(applied.success, true);
    const coding = tabs.filter(tab => /react|rust/i.test(tab.title)).map(tab => tab.id);
    const side = applied.groups.find(group => group.name === 'Side Project');
    assert.deepEqual([...side.tabIds].sort(), [...coding].sort());
  } finally {
    provider.restore();
  }
});

test('finding 4: two windows with identical rows each send their own request', async () => {
  const a = makeTabs(512, 51200);
  const b = a.map(tab => ({ ...tab, id: tab.id + 100, windowId: 513 }));
  installBrowser([...a, ...b]);
  const provider = installProvider({ delayMs: 300 });
  const offers = [];
  try {
    await executeTabGrouping(512, OPENAI, { ...LATE, onPlanOffer: id => offers.push(id) });
    await executeTabGrouping(513, OPENAI, { ...LATE, onPlanOffer: id => offers.push(id) });
    assert.equal(provider.requests.length, 2);
    assert.ok(await waitFor(() => offers.length === 2));
    assert.deepEqual(offers.sort(), [512, 513]);
  } finally {
    provider.restore();
  }
});

test('finding 5: when locked groups fill the cap no request is sent and the total stays within MAX_GROUPS', async () => {
  const tabs = makeTabs(514, 51400, { count: 12 });
  const { local } = installBrowser(tabs);
  await LearningCache.ensureSchema();
  tabs.slice(0, 10).forEach((tab, index) => addRule(local, new URL(tab.url).hostname.replace(/^www\./, ''), `Rule ${index}`));
  const provider = installProvider({ answer: () => ({ folders: [{ name: 'Project', ids: [0, 1] }] }) });
  try {
    const result = await executeTabGrouping(514, OPENAI);
    assert.equal(provider.requests.length, 0);
    assert.ok(result.groups.length <= MAX_GROUPS, `${result.groups.length} groups`);
    assert.equal(result.groups.filter(group => group.locked).length, 10);
    assert.equal(result.unplacedTabs, 2);
  } finally {
    provider.restore();
  }
});

test('finding 6: a Review Later-only answer keeps the local result without calling the engine unavailable, and offers nothing when late', async () => {
  const answer = rows => ({ folders: [{ name: 'Review Later', ids: rows.map(row => row[0]) }] });
  const tabs = makeTabs(515, 51500);
  installBrowser(tabs);
  const provider = installProvider({ answer });
  try {
    const result = await executeTabGrouping(515, OPENAI);
    assert.equal(provider.requests.length, 1);
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.fallbackCode, null);
    assert.equal(result.planReviewOnly, true);
    assert.ok(result.qualityFlags.includes('plan_review_only'));
    assert.ok(result.groups.length > 1, 'the local result is kept');
  } finally {
    provider.restore();
  }

  const lateTabs = makeTabs(516, 51600);
  installBrowser(lateTabs);
  const late = installProvider({ answer, delayMs: 200 });
  const offers = [];
  const failures = [];
  try {
    await executeTabGrouping(516, OPENAI, { ...LATE, onPlanOffer: id => offers.push(id), onPlanFailed: id => failures.push(id) });
    assert.ok(await waitFor(() => failures.length === 1));
    assert.deepEqual(offers, []);
    assert.equal(await PlanOfferStore.get(516), null);
  } finally {
    late.restore();
  }
});

test('finding 7: two cohorts the user renamed alike merge; two folders with the same local name stay apart', async () => {
  const tabs = makeTabs(517, 51700);
  installBrowser(tabs);
  const provider = installProvider();
  try {
    await LearningCache.learnGroupRename(tabs.filter((_, index) => index % 4 < 2), 'Same Name', 'blue');
    await LearningCache.learnGroupRename(tabs.filter((_, index) => index % 4 >= 2), 'Same Name', 'green');
    const result = await executeTabGrouping(517, OPENAI);
    assert.deepEqual(result.groups.map(group => [group.name, group.tabIds.length]), [['Same Name', 8]]);
  } finally {
    provider.restore();
  }

  const travel = makeTabs(518, 51800);
  installBrowser(travel);
  // Both folders hold travel tabs and have unusable names: each falls back to the local name.
  const fallback = installProvider({ answer: () => ({ folders: [{ name: '', ids: [2, 6] }, { name: '!!', ids: [3, 7] }] }) });
  try {
    const result = await executeTabGrouping(518, OPENAI);
    const folders = result.groups.filter(group => group.tabIds.some(id => [51802, 51803].includes(id)));
    assert.equal(folders.length, 2);
    assert.notEqual(folders[0].name.toLowerCase(), folders[1].name.toLowerCase());
    assert.deepEqual(membership(folders), ['51802,51806', '51803,51807']);
  } finally {
    fallback.restore();
  }
});

test('finding 8: an oversized raw folder name is rejected before normalising and validation stays linear', () => {
  assert.equal(validateGroupName(`Japan${' '.repeat(200)}Trip`), null);
  assert.equal(validateGroupName('Japan Trip'), 'Japan Trip');
  const tabs = makeTabs(519, 51900, { count: 2 });
  for (const length of [32000, 200000]) {
    const startedAt = performance.now();
    enforcePlan({ folders: [{ name: `A${'-'.repeat(length)}B`, ids: [0, 1] }] }, tabs);
    assert.ok(performance.now() - startedAt < 100, `${length} characters`);
  }
  // Linear trimming of a name inside the limit.
  const startedAt = performance.now();
  validateGroupName(`A${' -'.repeat(99)}`);
  assert.ok(performance.now() - startedAt < 20);
});

test('finding 9: a closed window gets no offer and no announcement', async () => {
  const tabs = makeTabs(520, 52000);
  installBrowser(tabs);
  const provider = installProvider({ delayMs: 200 });
  const offers = [];
  try {
    await executeTabGrouping(520, OPENAI, { ...LATE, onPlanOffer: id => offers.push(id) });
    tabs.length = 0;
    await cancelPlanWork(520);
    await sleep(350);
    assert.deepEqual(offers, []);
    assert.equal(await PlanOfferStore.get(520), null);
  } finally {
    provider.restore();
  }
});

test('finding 9: an offer is verified against the live window before it is stored or announced', async () => {
  const tabs = makeTabs(521, 52100);
  installBrowser(tabs);
  const provider = installProvider({ delayMs: 200 });
  const offers = [];
  try {
    await executeTabGrouping(521, OPENAI, { ...LATE, onPlanOffer: id => offers.push(id) });
    // A tab is closed while the request is out; no removal event cancels it.
    tabs.pop();
    await sleep(350);
    assert.deepEqual(offers, []);
    assert.equal(await PlanOfferStore.get(521), null);
  } finally {
    provider.restore();
  }
});

test('finding 10: a fragment change or a manual group change since the local result drops the offer', async () => {
  const tabs = makeTabs(522, 52200);
  tabs[0].url += '#/old';
  const { session } = installBrowser(tabs);
  const provider = installProvider({ delayMs: 100 });
  try {
    await lateOffer(522);
    const stored = JSON.stringify(session);
    assert.ok(!stored.includes('#/old') && !stored.includes(tabs[0].url), 'no URL is stored in clear');
    tabs[0].url = tabs[0].url.replace('#/old', '#/new');
    assert.equal(await getPlanOffer(522, { verify: true, settings: OPENAI }), null);
  } finally {
    provider.restore();
  }

  const moved = makeTabs(523, 52300);
  const { calls } = installBrowser(moved);
  const again = installProvider({ delayMs: 100 });
  try {
    await lateOffer(523);
    const before = calls.group.length;
    moved[0].groupId = 42;
    const result = await applyPlanOffer(523, OPENAI);
    assert.equal(result.success, false);
    assert.equal(result.reason, 'changed');
    assert.equal(moved[0].groupId, 42);
    assert.equal(calls.group.length, before);
  } finally {
    again.restore();
  }
});

test('finding 11: a changed engine, model or manual rule drops the offer on lookup, repeat click and Apply', async () => {
  const tabs = makeTabs(524, 52400);
  const { local } = installBrowser(tabs);
  const provider = installProvider({ delayMs: 100 });
  try {
    await lateOffer(524);
    const offline = await applyPlanOffer(524, { ...OPENAI, provider: 'offline' });
    assert.equal(offline.success, false);
    assert.equal(offline.reason, 'changed');

    await lateOffer(524);
    await LearningCache.ensureSchema();
    addRule(local, 'site-52400.com', 'Manual Project');
    assert.equal(await getPlanOffer(524, { verify: true, settings: OPENAI }), null);
    local[LearningCache.STORAGE_KEY] = [];

    await lateOffer(524);
    const before = provider.requests.length;
    const repeat = await executeTabGrouping(524, { ...OPENAI, openaiModel: 'gpt-5.5' }, LATE);
    assert.notEqual(repeat.source, 'plan-offer-pending');
    assert.equal(provider.requests.length, before + 1);
  } finally {
    provider.restore();
  }
});

test('finding 12: Apply rechecks the epoch and the window immediately before it changes the strip', async () => {
  const tabs = makeTabs(525, 52500);
  const { calls } = installBrowser(tabs);
  const provider = installProvider({ delayMs: 100 });
  const original = LearningCache.applyGroupPreferences;
  try {
    await lateOffer(525);
    const before = calls.group.length;
    LearningCache.applyGroupPreferences = async (groups, live) => {
      await LearningCache.resetRules();
      return original.call(LearningCache, groups, live);
    };
    const reset = await applyPlanOffer(525, OPENAI);
    assert.equal(reset.success, false);
    assert.equal(calls.group.length, before);
  } finally {
    LearningCache.applyGroupPreferences = original;
    provider.restore();
  }

  const moving = makeTabs(526, 52600);
  const browser = installBrowser(moving);
  const again = installProvider({ delayMs: 100 });
  try {
    await lateOffer(526);
    const before = browser.calls.group.length;
    LearningCache.applyGroupPreferences = async (groups, live) => {
      moving[0].url = 'https://navigated.example/new-page';
      return original.call(LearningCache, groups, live);
    };
    const result = await applyPlanOffer(526, OPENAI);
    assert.equal(result.success, false);
    assert.equal(result.reason, 'changed');
    assert.equal(browser.calls.group.length, before);
  } finally {
    LearningCache.applyGroupPreferences = original;
    again.restore();
  }
});

test('finding 13: Apply reports a Chrome refusal and keeps the offer and the caches untouched', async () => {
  const tabs = makeTabs(527, 52700);
  const { local } = installBrowser(tabs);
  const provider = installProvider({ delayMs: 100 });
  try {
    await lateOffer(527);
    const exactBefore = JSON.stringify(local[ExactResultCache.STORAGE_KEY] || []);
    const planBefore = await WindowPlanStore.get(527);
    chrome.tabs.group = async () => { throw new Error('Synthetic Chrome grouping error'); };
    const result = await applyPlanOffer(527, OPENAI);
    assert.equal(result.success, false);
    assert.equal(result.reason, 'failed');
    assert.ok(await PlanOfferStore.get(527), 'the offer is kept');
    assert.equal(JSON.stringify(local[ExactResultCache.STORAGE_KEY] || []), exactBefore);
    assert.deepEqual(await WindowPlanStore.get(527), planBefore);
  } finally {
    provider.restore();
  }
});

test('finding 14: a private window reads no offer and no cache on lookup, Apply or click', async () => {
  const tabs = makeTabs(528, 52800, { incognito: true });
  installBrowser(tabs);
  const reads = [];
  for (const area of ['local', 'session']) {
    const get = chrome.storage[area].get;
    chrome.storage[area].get = async keys => {
      reads.push(...(Array.isArray(keys) ? keys : [keys]).map(String));
      return get(keys);
    };
  }
  const provider = installProvider();
  try {
    assert.equal(await getPlanOffer(528, { verify: true, settings: OPENAI }), null);
    assert.equal((await applyPlanOffer(528, OPENAI)).success, false);
    await executeTabGrouping(528, OPENAI);
    const forbidden = reads.filter(key => key.startsWith(PlanOfferStore.KEY_PREFIX) || key.startsWith(WindowPlanStore.KEY_PREFIX)
      || [ExactResultCache.STORAGE_KEY, 'foldnex_tab_labels_v1', 'foldnex_plan_memory_v1'].includes(key));
    assert.deepEqual(forbidden, []);
  } finally {
    provider.restore();
  }
});

test('finding 15: an unchanged window reuses its applied plan when the exact cache has aged out or a rename cleared it', async () => {
  const tabs = makeTabs(529, 52900);
  const { local } = installBrowser(tabs);
  const provider = installProvider();
  try {
    const first = await executeTabGrouping(529, OPENAI);
    assert.equal(first.source, 'cloud-plan');
    local[ExactResultCache.STORAGE_KEY][0].createdAt -= 7 * 60 * 60 * 1000;
    const second = await executeTabGrouping(529, OPENAI);
    assert.equal(provider.requests.length, 1);
    assert.equal(second.source, 'stored-plan');
    assert.deepEqual(membership(second.groups), membership(first.groups));

    const side = first.groups.find(group => group.name === 'Side Project');
    await LearningCache.learnGroupRename(tabs.filter(tab => side.tabIds.includes(tab.id)), 'Weekend Code', 'green');
    const third = await executeTabGrouping(529, OPENAI);
    assert.equal(provider.requests.length, 1);
    assert.equal(third.source, 'stored-plan');
    assert.ok(third.groups.some(group => group.name === 'Weekend Code'));
  } finally {
    provider.restore();
  }

  // A local stand-in is not reused.
  const failing = makeTabs(530, 53000);
  installBrowser(failing);
  const broken = installProvider({ status: 500 });
  try {
    await executeTabGrouping(530, OPENAI);
    await executeTabGrouping(530, OPENAI);
    assert.equal(broken.requests.length, 2);
  } finally {
    broken.restore();
  }
});

test('minor 1: a late request that fails is reported so the popup can update its status', async () => {
  const tabs = makeTabs(531, 53100);
  installBrowser(tabs);
  const provider = installProvider({ delayMs: 150, status: 500 });
  const failures = [];
  try {
    const result = await executeTabGrouping(531, OPENAI, { ...LATE, onPlanFailed: id => failures.push(id) });
    assert.equal(result.source, 'plan-pending');
    assert.ok(await waitFor(() => failures.length === 1));
    assert.deepEqual(failures, [531]);
  } finally {
    provider.restore();
  }
});
