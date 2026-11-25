// The direct Anthropic engine (D47 to D49): request body per model, the pinned
// endpoint and headers, answer parsing, usage, the key's move to local storage
// and the optional host permission gate (D48).
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANTHROPIC_API_BASE,
  anthropicAnswerText,
  anthropicModelProfile,
  anthropicProfileFromCapabilities,
  buildAnthropicBody,
  getReasoningEffortOptions,
  hasProviderHostAccess,
  labelCacheScope,
  listProviderModels,
  planJsonSchema,
  planReasoningEffort,
  planWindowWithCloud,
  PROVIDER_CATALOG,
  resolveProviderEndpoint
} from '../src/ai-engine.js';
import { executeTabGrouping } from '../src/grouper.js';
import { installBrowser, makeTabs, topicFolders } from './plan-harness.js';

const KEY = 'synthetic-anthropic-key';
const ANTHROPIC = { provider: 'anthropic', anthropicApiKey: KEY, groupingStrategy: 'task' };
const rows = [
  { id: 1, title: 'React hooks reference', url: 'https://react.example/reference' },
  { id: 2, title: 'Tokyo hotel', url: 'https://travel.example/tokyo' }
];

/** A Messages API stand-in: records requests and answers with `reply(payload, rows)`. */
function installAnthropic({ reply = null, status = 200, usage = { input_tokens: 700, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } = {}) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const payload = options.body ? JSON.parse(options.body) : null;
    const user = payload?.messages?.at(-1)?.content || '';
    const tabRows = user.includes('{"tabs":') ? JSON.parse(user.slice(user.indexOf('{"tabs":'))).tabs : [];
    requests.push({ url: String(url), options, payload, rows: tabRows });
    if (status !== 200) {
      return { ok: false, status, statusText: 'Error', async json() { return { type: 'error', error: { type: 'invalid_request_error', message: 'Synthetic failure' } }; } };
    }
    const body = reply ? reply(payload, tabRows) : {
      type: 'message', role: 'assistant', model: payload?.model, stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(topicFolders(tabRows)) }],
      usage
    };
    return { ok: true, status: 200, async json() { return structuredClone(body); } };
  };
  return { requests, restore() { globalThis.fetch = original; } };
}

function setPermission(granted) {
  const calls = [];
  globalThis.chrome.permissions = {
    async contains(query) { calls.push(query); return granted; }
  };
  return calls;
}

test('the request body per model: Opus 5.5 low effort, Sonnet 5.5 between_tools, Haiku 5.5 disabled, no sampling', () => {
  const schema = planJsonSchema();
  const base = { system: 'S', user: 'U', jsonSchema: schema, maxTokens: 1500 };
  const opusEffort = planReasoningEffort('anthropic', 'claude-opus-5-5');
  assert.equal(opusEffort, 'low', 'Opus 5.5 cannot turn thinking off: its lowest effort');
  const opus = buildAnthropicBody({ ...base, model: 'claude-opus-5-5', reasoningEffort: opusEffort });
  assert.deepEqual(opus.output_config, { format: { type: 'json_schema', schema }, effort: 'low' });
  assert.equal(opus.thinking, undefined, 'thinking is omitted on Opus 5.5');
  assert.equal(opus.fallbacks, 'default');

  const sonnetEffort = planReasoningEffort('anthropic', 'claude-sonnet-5-5');
  assert.equal(sonnetEffort, 'none');
  const sonnet = buildAnthropicBody({ ...base, model: 'claude-sonnet-5-5', reasoningEffort: sonnetEffort });
  assert.deepEqual(sonnet.thinking, { type: 'between_tools' }, 'no other field inside between_tools');
  assert.equal(sonnet.output_config.effort, undefined, 'no effort beside between_tools');
  assert.equal(sonnet.fallbacks, 'default');

  const haiku = buildAnthropicBody({ ...base, model: 'claude-haiku-5-5', reasoningEffort: planReasoningEffort('anthropic', 'claude-haiku-5-5') });
  assert.deepEqual(haiku.thinking, { type: 'disabled' });
  assert.equal(haiku.fallbacks, undefined, 'Haiku has no server-side fallback');

  const unknown = buildAnthropicBody({ ...base, model: 'claude-future-9', reasoningEffort: planReasoningEffort('anthropic', 'claude-future-9') });
  assert.equal(unknown.thinking, undefined);
  assert.deepEqual(Object.keys(unknown.output_config), ['format'], 'an unknown model gets no effort or thinking field');

  for (const body of [opus, sonnet, haiku, unknown]) {
    for (const key of ['temperature', 'top_p', 'top_k', 'stop_sequences']) assert.equal(Object.hasOwn(body, key), false, key);
    assert.deepEqual(body.messages.map(message => message.role), ['user'], 'no assistant prefill');
    assert.equal(body.system, 'S');
    assert.equal(body.max_tokens, 1500);
  }
  const jsonMode = buildAnthropicBody({ ...base, model: 'claude-haiku-5-5', reasoningEffort: 'none', jsonMode: true });
  assert.equal(jsonMode.output_config, undefined, 'JSON mode drops the schema');
});

test('effort choices follow the model: none only where thinking can be off', () => {
  assert.deepEqual([...getReasoningEffortOptions('anthropic', 'claude-opus-5-5')], ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual([...getReasoningEffortOptions('anthropic', 'claude-sonnet-5-5')], ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual([...getReasoningEffortOptions('anthropic', 'claude-sonnet-4-6')], ['none', 'low', 'medium', 'high', 'max']);
  assert.deepEqual([...getReasoningEffortOptions('anthropic', 'claude-haiku-4-5-20251001')], [], 'no effort on Haiku 4.5');
  assert.deepEqual([...getReasoningEffortOptions('anthropic', 'claude-fable-5-2')], ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('Models API capabilities give the profile: efforts and the off setting as listed', () => {
  const profile = anthropicProfileFromCapabilities({
    effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: false }, max: { supported: true } },
    thinking: { supported: true, types: { adaptive: { supported: true }, disabled: { supported: true }, between_tools: { supported: false } } }
  });
  assert.deepEqual({ efforts: [...profile.efforts], off: profile.off }, { efforts: ['low', 'medium', 'high', 'max'], off: 'disabled' });
  assert.equal(anthropicProfileFromCapabilities(null), null);
  assert.equal(anthropicProfileFromCapabilities({ effort: { supported: true } }), null, 'no thinking types: not a profile');
});

test('the endpoint is fixed: no saved or synced override reaches the key, and redirects are refused', async () => {
  installBrowser([]);
  assert.equal(resolveProviderEndpoint('anthropic', 'https://attacker.example/v1'), ANTHROPIC_API_BASE);
  assert.equal(PROVIDER_CATALOG.anthropic.baseUrl, ANTHROPIC_API_BASE);
  const scope = labelCacheScope({ provider: 'anthropic' });
  assert.equal(labelCacheScope({ provider: 'anthropic', anthropicBaseUrl: 'https://attacker.example/v1' }), scope);
  const api = installAnthropic({ reply: payload => payload ? {
    stop_reason: 'end_turn', content: [{ type: 'text', text: '{"folders":[{"name":"Mixed Notes","ids":[0,1]}]}' }], usage: { input_tokens: 10, output_tokens: 5 }
  } : { data: [], has_more: false } });
  try {
    await planWindowWithCloud(rows, 2, { ...ANTHROPIC, anthropicBaseUrl: 'https://attacker.example/v1' }, { recordUsage: false });
    await listProviderModels('anthropic', { apiKey: KEY, baseUrl: 'https://attacker.example/v1' });
    assert.deepEqual(api.requests.map(request => request.url), [`${ANTHROPIC_API_BASE}/messages`, `${ANTHROPIC_API_BASE}/models?limit=1000`]);
    for (const { options } of api.requests) {
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['x-api-key'], KEY);
      assert.equal(options.headers['anthropic-version'], '2026-10-21');
      assert.equal(options.headers['anthropic-dangerous-direct-browser-access'], 'true');
      assert.equal(options.headers.Authorization, undefined, 'the key goes only in x-api-key');
    }
    assert.equal(api.requests[0].options.headers['anthropic-beta'], 'server-side-fallback-2026-07-01', 'Opus 5.5 default model with fallback');
    assert.equal(api.requests[0].payload.model, 'claude-opus-5-5');
  } finally {
    api.restore();
  }
});

test('answer parsing: the text after any fallback block counts, thinking never does', () => {
  const plan = '{"folders":[{"name":"Japan Holiday","ids":[0,1]}]}';
  assert.equal(anthropicAnswerText({ stop_reason: 'end_turn', content: [
    { type: 'thinking', thinking: '{"folders":[]}' },
    { type: 'text', text: '{"folders":[{"name":"Declined","ids":[0]' },
    { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
    { type: 'thinking', thinking: '' },
    { type: 'text', text: plan }
  ] }), plan);
  assert.equal(anthropicAnswerText({ stop_reason: 'end_turn', content: [{ type: 'redacted_thinking', data: 'x' }, { type: 'text', text: plan }] }), plan);
  assert.throws(() => anthropicAnswerText({ stop_reason: 'refusal', content: [{ type: 'text', text: plan }] }), error => error.code === 'refusal');
  assert.throws(() => anthropicAnswerText({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"folders":[' }] }), error => error.code === 'max_tokens');
});

test('a refusal, a cut-off answer and malformed JSON end the plan without a usable answer', async () => {
  installBrowser([]);
  for (const [reply, expect] of [
    [{ stop_reason: 'refusal', content: [], usage: { input_tokens: 5, output_tokens: 0 } }, /refusal/],
    [{ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"folders":[' }], usage: { input_tokens: 5, output_tokens: 9 } }, /output limit/]
  ]) {
    const api = installAnthropic({ reply: () => reply });
    try {
      await assert.rejects(planWindowWithCloud(rows, 2, ANTHROPIC, { recordUsage: false }), expect);
      assert.equal(api.requests.length, 1, 'never retried');
    } finally {
      api.restore();
    }
  }
  const api = installAnthropic({ reply: () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json at all' }], usage: { input_tokens: 5, output_tokens: 4 } }) });
  const error = console.error;
  console.error = () => {};
  try {
    const result = await planWindowWithCloud(rows, 2, ANTHROPIC, { recordUsage: false });
    assert.equal(result.json, null);
  } finally {
    console.error = error;
    api.restore();
  }
});

test('usage is recorded under anthropic with input, output, cache read and cache write tokens', async () => {
  installBrowser([]);
  const api = installAnthropic({ usage: { input_tokens: 600, output_tokens: 80, cache_read_input_tokens: 100, cache_creation_input_tokens: 40, output_tokens_details: { thinking_tokens: 12 } } });
  try {
    const result = await planWindowWithCloud(rows, 2, ANTHROPIC);
    assert.deepEqual(result.meta.usage, { promptTokens: 740, completionTokens: 80, totalTokens: 820, cachedTokens: 100, cacheWriteTokens: 40, reasoningTokens: 12 });
    const { readProviderUsageSummary } = await import('../src/provider-usage.js');
    const summary = await readProviderUsageSummary();
    assert.deepEqual(
      { ...summary.byProvider.anthropic },
      { calls: 1, unknownUsageCalls: 0, promptTokens: 740, completionTokens: 80, cachedTokens: 100, cacheWriteTokens: 40, reasoningTokens: 12, totalTokens: 820 }
    );
  } finally {
    api.restore();
  }
});

test('an Anthropic key saved in Sync by an older build moves to local storage and leaves Sync', async () => {
  const sync = { provider: 'anthropic', anthropicApiKey: KEY, anthropicModel: 'claude-sonnet-5-5' };
  const local = {};
  const area = store => ({
    async get(keys) {
      if (keys == null) return structuredClone(store);
      return Object.fromEntries([].concat(keys).filter(key => key in store).map(key => [key, store[key]]));
    },
    async set(values) { Object.assign(store, values); },
    async remove(keys) { for (const key of [].concat(keys)) delete store[key]; }
  });
  globalThis.chrome = { storage: { sync: area(sync), local: area(local), session: area({}) } };
  const { loadSettings, saveProviderSecrets } = await import('../src/settings.js');
  const settings = await loadSettings();
  assert.equal(settings.anthropicApiKey, KEY);
  assert.equal(local.anthropicApiKey, KEY);
  assert.equal(Object.hasOwn(sync, 'anthropicApiKey'), false);
  assert.equal(sync.anthropicModel, 'claude-sonnet-5-5', 'preferences stay in Sync');
  await saveProviderSecrets({ anthropicApiKey: 'replacement' });
  assert.equal(local.anthropicApiKey, 'replacement');
  assert.equal(Object.hasOwn(sync, 'anthropicApiKey'), false);
});

test('without the host permission nothing is sent: plan, catalogue and a cleanup', async () => {
  const tabs = makeTabs(951, 95100);
  const { local } = installBrowser(tabs);
  const checks = setPermission(false);
  const api = installAnthropic();
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await hasProviderHostAccess('anthropic'), false);
    assert.equal(await hasProviderHostAccess('openai'), true, 'install-time hosts need no check');
    await assert.rejects(planWindowWithCloud(rows, 2, ANTHROPIC, { recordUsage: false }), error => error.code === 'permission');
    await assert.rejects(listProviderModels('anthropic', { apiKey: KEY }), error => error.code === 'permission');
    const result = await executeTabGrouping(951, ANTHROPIC);
    assert.equal(api.requests.length, 0, 'no request without the permission');
    assert.ok(checks.every(query => query.origins?.[0] === 'https://api.anthropic.com/*'));
    assert.equal(result.success, true);
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.fallbackCode, 'permission');
    assert.ok(result.groupsCreated > 0, 'the cleanup ran locally');
    assert.match(result.message, /not allowed\. Allow it in Settings/);
    assert.equal(local.foldnex_last_run.fallbackCode, 'permission');
    assert.equal(local.foldnex_last_run.modelCalls.plan, 0);
  } finally {
    console.warn = warn;
    api.restore();
  }
});

test('with the permission one plan request groups the window; a private window sends nothing', async () => {
  const tabs = makeTabs(952, 95200);
  installBrowser(tabs);
  setPermission(true);
  const api = installAnthropic();
  try {
    const result = await executeTabGrouping(952, ANTHROPIC);
    assert.equal(result.source, 'cloud-plan');
    assert.equal(result.model, 'claude-opus-5-5');
    assert.equal(api.requests.length, 1);
    assert.deepEqual(new Set(result.groups.map(group => group.name)), new Set(['Side Project', 'Japan Holiday']));
  } finally {
    api.restore();
  }

  const privateTabs = makeTabs(953, 95300, { incognito: true });
  installBrowser(privateTabs);
  setPermission(true);
  const quiet = installAnthropic();
  try {
    const result = await executeTabGrouping(953, ANTHROPIC);
    assert.equal(quiet.requests.length, 0, 'a private window never sends');
    assert.ok(result.groupsCreated > 0);
  } finally {
    quiet.restore();
  }
});

test('the model catalogue lists only Claude chat models, pages by after_id and keeps capabilities', async () => {
  installBrowser([]);
  setPermission(true);
  const pages = [
    { data: [
      { type: 'model', id: 'claude-test-alpha', capabilities: { effort: { supported: true, low: { supported: true }, medium: { supported: false }, high: { supported: true } }, thinking: { types: { disabled: { supported: true } } } } },
      { type: 'model', id: 'not-a-claude-model' }
    ], has_more: true, last_id: 'claude-test-alpha' },
    { data: [{ type: 'model', id: 'claude-opus-5-5' }], has_more: false, last_id: 'claude-opus-5-5' }
  ];
  const api = installAnthropic({ reply: () => pages.shift() });
  try {
    const models = await listProviderModels('anthropic', { apiKey: KEY });
    assert.deepEqual(models, ['claude-opus-5-5', 'claude-test-alpha']);
    assert.match(api.requests[1].url, /after_id=claude-test-alpha/);
    const profile = anthropicModelProfile('claude-test-alpha');
    assert.deepEqual({ efforts: [...profile.efforts], off: profile.off }, { efforts: ['low', 'high'], off: 'disabled' });
    assert.deepEqual([...getReasoningEffortOptions('anthropic', 'claude-test-alpha')], ['none', 'low', 'high']);
  } finally {
    api.restore();
  }
});
