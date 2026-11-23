import assert from 'node:assert/strict';
import test from 'node:test';

import { LearningCache, PlanOfferStore } from '../src/cache-engine.js';
import { applyPlanOffer, executeTabGrouping, getPlanOffer, ungroupAllTabs } from '../src/grouper.js';

import { installBrowser, installProvider, makeTabs, OPENAI, sleep, topicFolders, waitFor } from './plan-harness.js';

// Regression tests for the second Phase 1 review (2026-11-22). Each test
// names the item it covers: "new N" from its new defects, "orig N" from its
// original findings.

const LATE = { budgetMs: 300 };

async function lateOffer(windowId, settings = OPENAI) {
  const offers = [];
  const result = await executeTabGrouping(windowId, settings, { ...LATE, onPlanOffer: id => offers.push(id) });
  assert.equal(result.source, 'plan-pending');
  assert.ok(await waitFor(async () => offers.length > 0 && Boolean(await PlanOfferStore.get(windowId))), 'the late plan is offered');
}

function addRules(local, tabs) {
  local[LearningCache.STORAGE_KEY] = tabs.map((tab, index) => ({
    pattern: `${new URL(tab.url).hostname.replace(/^www\./, '')}/*`,
    category: `Rule ${index}`,
    source: 'manual_rule',
    confidence: 1,
    userOverride: true
  }));
}

const schemaRejection = (param, message) => ({ ok: false, status: 400, async json() { return { error: { param, message } }; } });

function rowsOf(user) {
  return JSON.parse(user.slice(user.indexOf('{"tabs":'))).tabs;
}

test('new 1: the JSON-mode fact never crosses the incognito boundary, in either direction', async () => {
  const privateTabs = makeTabs(601, 60100, { incognito: true });
  const normalTabs = makeTabs(602, 60200);
  const { session } = installBrowser([...privateTabs, ...normalTabs]);
  const formats = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, { body }) => {
    const payload = JSON.parse(body);
    formats.push(payload.response_format.type);
    if (payload.response_format.type === 'json_schema') return schemaRejection('response_format', 'Unsupported response_format');
    const content = JSON.stringify(topicFolders(rowsOf(payload.messages.at(-1).content)));
    return { ok: true, async json() { return { choices: [{ message: { content } }] }; } };
  };
  const settings = { ...OPENAI, openaiModel: 'gpt-5.2' };
  try {
    // A private window sends nothing (D40), so it neither learns nor reads the fact.
    await executeTabGrouping(601, settings);
    assert.deepEqual(formats, []);
    assert.equal(session.foldnex_plan_json_mode_v1, undefined);
    await executeTabGrouping(602, settings);
    assert.deepEqual(formats, ['json_schema'], 'the normal window tries the schema first');
    await executeTabGrouping(602, settings);
    assert.deepEqual(formats, ['json_schema', 'json_object'], 'a normal rejection is remembered');
    await executeTabGrouping(601, settings);
    assert.equal(formats.length, 2, 'the private window still sends nothing');
  } finally {
    globalThis.fetch = original;
  }
});

test('new 2: a throw after the deadline leaves no window stuck as pending', async () => {
  const tabs = makeTabs(603, 60300);
  installBrowser(tabs);
  const provider = installProvider({ delayMs: 400 });
  const original = LearningCache.applyGroupPreferences;
  LearningCache.applyGroupPreferences = async () => { throw new Error('Storage failed once'); };
  try {
    await assert.rejects(executeTabGrouping(603, OPENAI, LATE), /Storage failed once/);
  } finally {
    LearningCache.applyGroupPreferences = original;
  }
  try {
    const repeat = await executeTabGrouping(603, OPENAI);
    assert.equal(repeat.source, 'cloud-plan', 'the next click works normally');
    assert.equal(provider.requests.length, 2);
    await sleep(450);
    assert.equal(await PlanOfferStore.get(603), null);
  } finally {
    provider.restore();
  }
});

test('new 3: Ungroup cancels pending plan work for the window and clears its offer', async () => {
  // A request not yet dispatched when Ungroup runs is never sent.
  const held = makeTabs(604, 60400);
  installBrowser(held);
  const provider = installProvider({ delayMs: 50 });
  const get = chrome.storage.session.get;
  let release = null;
  chrome.storage.session.get = async keys => {
    if (keys === 'foldnex_plan_json_mode_v1') await new Promise(resolve => { release = resolve; });
    return get(keys);
  };
  const offers = [];
  try {
    const click = await executeTabGrouping(604, OPENAI, { budgetMs: 200, onPlanOffer: id => offers.push(id) });
    assert.equal(click.source, 'plan-pending');
    await ungroupAllTabs(604);
    release();
    await sleep(150);
    assert.equal(provider.requests.length, 0, 'no request after Ungroup');
    assert.deepEqual(offers, []);
  } finally {
    chrome.storage.session.get = get;
    provider.restore();
  }

  // A request in flight produces no offer.
  const flying = makeTabs(605, 60500);
  installBrowser(flying);
  const inFlight = installProvider({ delayMs: 300 });
  try {
    const click = await executeTabGrouping(605, OPENAI, { budgetMs: 100, onPlanOffer: id => offers.push(id) });
    assert.equal(click.source, 'plan-pending');
    assert.equal(inFlight.requests.length, 1);
    await ungroupAllTabs(605);
    await sleep(400);
    assert.deepEqual(offers, []);
    assert.equal(await PlanOfferStore.get(605), null);
  } finally {
    inFlight.restore();
  }

  // An offer already waiting is cleared.
  const offered = makeTabs(606, 60600);
  installBrowser(offered);
  const late = installProvider({ delayMs: 400 });
  try {
    await lateOffer(606);
    await ungroupAllTabs(606);
    assert.equal(await PlanOfferStore.get(606), null);
  } finally {
    late.restore();
  }
});

test('orig 1: a Gemini schema rejection is remembered, so the next plan request goes without the schema', async () => {
  const tabs = makeTabs(608, 60800);
  installBrowser(tabs);
  const schemas = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, { body }) => {
    const payload = JSON.parse(body);
    const hasSchema = Boolean(payload.generationConfig.responseSchema);
    schemas.push(hasSchema);
    if (hasSchema) return schemaRejection('generation_config.response_schema', 'Unsupported response schema');
    const text = JSON.stringify(topicFolders(rowsOf(payload.contents[0].parts[0].text)));
    return { ok: true, async json() { return { candidates: [{ content: { parts: [{ text }] } }] }; } };
  };
  const settings = { provider: 'gemini_api', geminiApiKey: 'test-only', groupingStrategy: 'task' };
  try {
    const first = await executeTabGrouping(608, settings);
    assert.equal(first.source, 'offline-fallback');
    const second = await executeTabGrouping(608, settings);
    assert.deepEqual(schemas, [true, false]);
    assert.equal(second.source, 'cloud-plan');
  } finally {
    globalThis.fetch = original;
  }
});

test('orig 3: an answer that settles after the deadline is late even before the timer fires', async () => {
  const tabs = makeTabs(609, 60900);
  installBrowser(tabs);
  const original = globalThis.fetch;
  globalThis.fetch = async (url, { body }) => {
    const rows = rowsOf(JSON.parse(body).messages.at(-1).content);
    return {
      ok: true,
      async json() {
        // Parsing the body holds the event loop past the deadline.
        const end = performance.now() + 730;
        while (performance.now() < end) { /* busy */ }
        return { choices: [{ message: { content: JSON.stringify(topicFolders(rows)) } }] };
      }
    };
  };
  try {
    const result = await executeTabGrouping(609, OPENAI, { budgetMs: 700 });
    assert.equal(result.source, 'plan-pending');
    assert.equal(result.deadlineHit, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('orig 5: with no free slot the tabs reported as ungrouped are ungrouped on the strip', async () => {
  const tabs = makeTabs(610, 61000, { count: 13 });
  const { local } = installBrowser(tabs);
  await LearningCache.ensureSchema();
  addRules(local, tabs.slice(0, 10));
  tabs.slice(10).forEach(tab => { tab.groupId = 42; });
  const provider = installProvider();
  try {
    const result = await executeTabGrouping(610, OPENAI);
    assert.equal(provider.requests.length, 0);
    assert.deepEqual(tabs.slice(10).map(tab => tab.groupId), [-1, -1, -1]);
    assert.equal(result.unplacedTabs, 3);
    const live = new Set(tabs.map(tab => tab.groupId).filter(id => id !== -1));
    assert.equal(live.size, 10);
  } finally {
    provider.restore();
  }
});

test('orig 6: a valid answer whose only model folder loses the last slot to Review Later keeps the local result', async () => {
  const tabs = makeTabs(611, 61100, { count: 13 });
  const { local } = installBrowser(tabs);
  await LearningCache.ensureSchema();
  addRules(local, tabs.slice(0, 9));
  const provider = installProvider({ answer: () => ({ folders: [{ name: 'Project', ids: [0, 1] }] }) });
  try {
    const result = await executeTabGrouping(611, OPENAI);
    assert.equal(provider.requests.length, 1);
    assert.equal(result.source, 'local');
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.fallbackCode, null);
    assert.equal(result.planReviewOnly, true);
    assert.ok(result.qualityFlags.includes('plan_review_only'));
  } finally {
    provider.restore();
  }
});

test('orig 10: an offer is not applied to a tab that is navigating away', async () => {
  const tabs = makeTabs(612, 61200);
  const { calls } = installBrowser(tabs);
  const provider = installProvider({ delayMs: 100 });
  try {
    await lateOffer(612);
    const before = calls.group.length;
    tabs[0].status = 'loading';
    tabs[0].pendingUrl = 'https://navigated.example/';
    const result = await applyPlanOffer(612, OPENAI);
    assert.equal(result.success, false);
    assert.equal(result.reason, 'changed');
    assert.equal(calls.group.length, before);
    assert.equal(await getPlanOffer(612, { verify: true, settings: OPENAI }), null);
  } finally {
    provider.restore();
  }
});

test('orig 12: Apply reads the reset epoch after its last policy read', async () => {
  const tabs = makeTabs(613, 61300);
  const { calls } = installBrowser(tabs);
  const provider = installProvider({ delayMs: 100 });
  const original = LearningCache.classifyExplicit;
  try {
    await lateOffer(613);
    const before = calls.group.length;
    let count = 0;
    LearningCache.classifyExplicit = async (...args) => {
      if (++count === 2) await LearningCache.resetRules();
      return original.apply(LearningCache, args);
    };
    const result = await applyPlanOffer(613, OPENAI);
    assert.equal(count, 2);
    assert.equal(result.success, false);
    assert.equal(calls.group.length, before);
  } finally {
    LearningCache.classifyExplicit = original;
    provider.restore();
  }
});
