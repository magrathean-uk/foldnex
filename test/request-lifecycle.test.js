import assert from 'node:assert/strict';
import test from 'node:test';

import { planWindowWithCloud } from '../src/ai-engine.js';
import { createClickBudget } from '../src/grouper.js';
import { readProviderUsageSummary } from '../src/provider-usage.js';

const settings = { provider: 'openai', openaiApiKey: 'synthetic-test-key', openaiPriority: false };
const usage = {
  prompt_tokens: 100, completion_tokens: 12, total_tokens: 112,
  prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 5 }
};

function tabs(ids = [1, 2, 3]) {
  return ids.map((id, index) => ({
    id, windowId: 1, index, incognito: false, pinned: false,
    title: ['React hooks reference', 'Tokyo flights and hotel', 'Ramen recipe ingredients'][index % 3],
    url: `https://topic-${index}.example/article/${index}`
  }));
}

function category(title) {
  return /React/.test(title) ? 'dev' : /Tokyo|flight/.test(title) ? 'travel' : 'food';
}

function installStorage() {
  const local = {};
  const area = store => ({
    async get(keys) {
      if (keys == null) return structuredClone(store);
      return Object.fromEntries([].concat(keys).filter(key => key in store).map(key => [key, structuredClone(store[key])]));
    },
    async set(values) { Object.assign(store, structuredClone(values)); },
    async remove(keys) { for (const key of [].concat(keys)) delete store[key]; }
  });
  globalThis.chrome = { storage: { local: area(local), sync: area({}), session: area({}) } };
  return local;
}

/** Controlled HTTP boundary: every response is synthetic and can be held open. */
function installProvider({ hold = true, returnedTier = null } = {}) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    const prompt = payload.messages?.at(-1)?.content || payload.contents?.[0]?.parts?.[0]?.text;
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
    const kind = input.tabs ? 'label' : 'consolidate';
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const request = { url, payload, kind, rows: input.tabs || input.rows, signal: options.signal, release };
    requests.push(request);
    if (hold) await gate;
    const answer = kind === 'label'
      ? Object.fromEntries(request.rows.map(([id, title]) => [id, category(title)]))
      : { folders: request.rows.map(([id, dominant]) => ({ name: `${dominant} topics`, ids: [id] })) };
    const gemini = Boolean(payload.contents);
    return { ok: true, async json() {
      return gemini
        ? { candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 12, totalTokenCount: 112, cachedContentTokenCount: 20, thoughtsTokenCount: 5 } }
        : { model: payload.model, choices: [{ message: { content: JSON.stringify(answer) } }], usage, service_tier: returnedTier ?? payload.service_tier };
    } };
  };
  return {
    requests,
    releaseAll() { for (const request of requests) request.release(); },
    restore() { for (const request of requests) request.release(); globalThis.fetch = original; }
  };
}

test('a dispatched HTTP 401 counts its plan request while recording no known usage', async () => {
  installStorage();
  const original = globalThis.fetch;
  let requests = 0;
  let dispatched = 0;
  globalThis.fetch = async () => {
    requests++;
    return { ok: false, status: 401, async json() { return { error: { message: 'Synthetic authentication failure' } }; } };
  };
  try {
    await assert.rejects(planWindowWithCloud(tabs(), 2, settings, { onDispatch: () => { dispatched++; } }), /HTTP 401/);
    assert.equal(requests, 1);
    assert.equal(dispatched, 1);
    const cumulative = await readProviderUsageSummary();
    assert.equal(cumulative.calls, 1);
    assert.equal(cumulative.unknownUsageCalls, 1);
  } finally { globalThis.fetch = original; }
});

test('missing credentials and unsupported model settings fail before dispatch and count zero calls', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; assert.fail('Preflight failures must not send HTTP requests'); };
  try {
    for (const invalid of [
      { provider: 'openai' },
      { provider: 'gemini_api' },
      { ...settings, openaiModel: 'gpt-5.5-pro' }
    ]) {
      installStorage();
      let dispatched = 0;
      await assert.rejects(planWindowWithCloud(tabs(), 2, invalid, { onDispatch: () => { dispatched++; } }));
      assert.equal(dispatched, 0);
      assert.equal((await readProviderUsageSummary()).calls, 0);
    }
    assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
});

test('Priority off sends an explicit default tier and records the returned service tier', async () => {
  installStorage();
  const provider = installProvider({ hold: false, returnedTier: 'flex' });
  try {
    await planWindowWithCloud(tabs([70, 71]), 2, settings);
    await planWindowWithCloud(tabs([70, 71]), 2, { ...settings, openaiPriority: true });
    assert.deepEqual(provider.requests.map(request => request.payload.service_tier), ['default', 'priority']);
    assert.deepEqual((await readProviderUsageSummary()).serviceTiers, { flex: 2 });
  } finally { provider.restore(); }
});

// Restored with the label pipeline's removal (D34): the same request seam now serves the plan.
test('a signal aborted before dispatch sends no request and notifies no dispatch', async () => {
  installStorage();
  const original = globalThis.fetch;
  let requests = 0;
  let dispatches = 0;
  globalThis.fetch = async () => { requests++; assert.fail('An aborted request must not be sent'); };
  try {
    const controller = new AbortController();
    controller.abort(new Error('Synthetic cancellation'));
    await assert.rejects(planWindowWithCloud(tabs(), 2, settings, { signal: controller.signal, onDispatch: () => { dispatches++; } }), /Synthetic cancellation/);
    assert.equal(requests, 0);
    assert.equal(dispatches, 0);
    assert.equal((await readProviderUsageSummary()).calls, 0);
  } finally { globalThis.fetch = original; }
});

test('a successful plan response arriving after the click cutoff still reaches the usage ledger', async () => {
  installStorage();
  const original = globalThis.fetch;
  const held = Promise.withResolvers();
  const sent = [];
  globalThis.fetch = async (_url, options) => {
    sent.push(options.signal);
    await held.promise;
    const answer = { folders: [{ name: 'Mixed', ids: [0, 1, 2] }] };
    return { ok: true, async json() { return { model: 'synthetic', choices: [{ message: { content: JSON.stringify(answer) } }], usage }; } };
  };
  try {
    const budget = createClickBudget(30);
    const request = planWindowWithCloud(tabs(), 2, settings);
    const outcome = await Promise.race([request.then(() => 'answered'), new Promise(resolve => setTimeout(() => resolve('cutoff'), budget.remaining()))]);
    assert.equal(outcome, 'cutoff');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].aborted, false, 'the cutoff leaves a non-private request running');
    assert.equal((await readProviderUsageSummary()).calls, 0);
    held.resolve();
    const late = await request;
    assert.deepEqual(late.json.folders[0].ids, [0, 1, 2]);
    const ledger = await readProviderUsageSummary();
    assert.equal(ledger.calls, 1);
    assert.equal(ledger.completionTokens, 12);
    assert.equal(ledger.byProvider.openai.calls, 1);
  } finally { held.resolve(); globalThis.fetch = original; }
});
