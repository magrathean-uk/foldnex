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
  ANTHROPIC_PROFILE_KEY,
  anthropicStoredProfile,
  PROVIDER_CATALOG,
  planRequestBudget,
  publishAnthropicCatalogProfiles,
  registerAnthropicModelProfile,
  requestProviderHostAccess,
  resolveProviderEndpoint
} from '../src/ai-engine.js';
import { executeTabGrouping } from '../src/grouper.js';
import { loadSettings } from '../src/settings.js';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installBrowser, makeTabs, topicFolders } from './plan-harness.js';

const KEY = 'synthetic-anthropic-key';
const ANTHROPIC = { provider: 'anthropic', anthropicApiKey: KEY, groupingStrategy: 'task' };
const rows = [
  { id: 1, title: 'React hooks reference', url: 'https://react.example/reference' },
  { id: 2, title: 'Tokyo hotel', url: 'https://travel.example/tokyo' }
];

/** A Messages API stand-in: records requests and answers with `reply(payload, rows)`. */
function installAnthropic({ reply = null, fail = null, status = 200, usage = { input_tokens: 700, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } = {}) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const payload = options.body ? JSON.parse(options.body) : null;
    const user = payload?.messages?.at(-1)?.content || '';
    const tabRows = user.includes('{"tabs":') ? JSON.parse(user.slice(user.indexOf('{"tabs":'))).tabs : [];
    requests.push({ url: String(url), options, payload, rows: tabRows });
    const refusal = fail?.(payload, requests.length);
    if (refusal) {
      const { message, param } = typeof refusal === 'string' ? { message: refusal } : refusal;
      return { ok: false, status: 400, statusText: 'Bad Request', async json() { return { type: 'error', error: { type: 'invalid_request_error', message, ...(param ? { param } : {}) } }; } };
    }
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
    // `granted` is a boolean, or a function of the number of checks so far (a grant revoked mid-operation).
    async contains(query) { calls.push(query); return typeof granted === 'function' ? granted(calls.length) : granted; }
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

const EFFORT_ONLY = { efforts: ['low', 'high'], off: null };

test('a 400 about effort retries once without effort and thinking, keeps the schema and never sets JSON mode', async () => {
  const { local } = installBrowser([]);
  registerAnthropicModelProfile({ model: 'claude-effort-a', ...EFFORT_ONLY });
  const settings = { ...ANTHROPIC, anthropicModel: 'claude-effort-a' };
  const api = installAnthropic({ fail: payload => payload.output_config?.effort ? 'output_config.effort: Input should be a supported level' : null });
  try {
    const first = await planWindowWithCloud(rows, 2, settings);
    assert.equal(api.requests.length, 2, 'one retry');
    assert.equal(api.requests[0].payload.output_config.effort, 'low');
    const retry = api.requests[1].payload;
    assert.equal(retry.output_config.effort, undefined, 'the retry drops effort');
    assert.equal(retry.thinking, undefined, 'and thinking');
    assert.equal(retry.output_config.format.type, 'json_schema', 'the schema stays');
    assert.ok(first.json, 'the retried answer is used');
    assert.equal(Object.keys(local).some(key => /json_mode/.test(key)), false);

    // The next plan still sends the schema: nothing remembered JSON mode.
    await planWindowWithCloud(rows, 2, settings);
    assert.equal(api.requests[2].payload.output_config.format.type, 'json_schema');
  } finally {
    api.restore();
  }
});

test('an effort 400 that persists is not a schema rejection; a format 400 is', async () => {
  installBrowser([]);
  registerAnthropicModelProfile({ model: 'claude-effort-b', ...EFFORT_ONLY });
  const settings = { ...ANTHROPIC, anthropicModel: 'claude-effort-b' };
  const stubborn = installAnthropic({ fail: () => 'thinking: this model does not accept the field' });
  try {
    await assert.rejects(planWindowWithCloud(rows, 2, settings), error => error.status === 400 && !error.schemaRejected);
    assert.equal(stubborn.requests.length, 2, 'retried once, then the error stands');
  } finally {
    stubborn.restore();
  }
  const after = installAnthropic();
  try {
    await planWindowWithCloud(rows, 2, settings);
    assert.equal(after.requests[0].payload.output_config.format.type, 'json_schema', 'no JSON mode was remembered');
  } finally {
    after.restore();
  }

  registerAnthropicModelProfile({ model: 'claude-format-c', ...EFFORT_ONLY });
  const formatSettings = { ...ANTHROPIC, anthropicModel: 'claude-format-c' };
  const format = installAnthropic({ fail: payload => payload.output_config?.format ? 'output_config.format.schema: not supported' : null });
  try {
    await assert.rejects(planWindowWithCloud(rows, 2, formatSettings), error => error.schemaRejected === true);
    assert.equal(format.requests.length, 1, 'a schema rejection is not retried inside the plan');
    await planWindowWithCloud(rows, 2, formatSettings);
    assert.equal(format.requests[1].payload.output_config?.format, undefined, 'the next plan goes out in JSON mode');
  } finally {
    format.restore();
  }
});

test('the chosen model\'s profile saved with the settings is the one every context sends, and an unknown model gets reasoning headroom', async () => {
  const { local } = installBrowser([]);
  registerAnthropicModelProfile({ model: 'claude-stored-d', efforts: ['low', 'medium'], off: 'disabled' });
  const stored = anthropicStoredProfile('claude-stored-d');
  assert.deepEqual(stored, { model: 'claude-stored-d', efforts: ['low', 'medium'], off: 'disabled' });
  assert.equal(anthropicStoredProfile('claude-never-listed'), null);

  // Another context (the service worker, the popup) starts without it, then loads the settings.
  local[ANTHROPIC_PROFILE_KEY] = { model: 'claude-stored-e', efforts: ['low', 'high', 'bogus'], off: 'between_tools' };
  assert.deepEqual([...getReasoningEffortOptions('anthropic', 'claude-stored-e')], [], 'unknown before the settings load');
  const settings = await loadSettings();
  assert.equal(settings[ANTHROPIC_PROFILE_KEY].model, 'claude-stored-e', 'no key in the stored record');
  assert.deepEqual([...getReasoningEffortOptions('anthropic', 'claude-stored-e')], ['none', 'low', 'high']);
  assert.equal(planReasoningEffort('anthropic', 'claude-stored-e'), 'none');
  local[ANTHROPIC_PROFILE_KEY] = { model: 'claude-stored-f', efforts: 'low', off: 'disabled' };
  await loadSettings();
  assert.deepEqual([...getReasoningEffortOptions('anthropic', 'claude-stored-f')], [], 'a damaged record is ignored');
  assert.deepEqual([...getReasoningEffortOptions('anthropic', 'claude-stored-e')], [], 'the snapshot is replaced by every load (L3)');
  local[ANTHROPIC_PROFILE_KEY] = { model: 'claude-stored-e', efforts: ['low', 'high', 'bogus'], off: 'between_tools' };
  await loadSettings();

  const api = installAnthropic();
  try {
    await planWindowWithCloud(rows, 2, { ...ANTHROPIC, anthropicModel: 'claude-stored-e' }, { recordUsage: false });
    const known = api.requests.at(-1).payload;
    assert.deepEqual(known.thinking, { type: 'between_tools' });
    assert.equal(known.max_tokens, planRequestBudget(rows.length, 'none'), 'thinking off: no headroom');
    await planWindowWithCloud(rows, 2, { ...ANTHROPIC, anthropicModel: 'claude-unlisted-g' }, { recordUsage: false });
    const unknown = api.requests.at(-1).payload;
    assert.equal(unknown.thinking, undefined);
    assert.equal(unknown.output_config.effort, undefined);
    assert.equal(unknown.max_tokens, planRequestBudget(rows.length, null, true));
    assert.ok(unknown.max_tokens > known.max_tokens, 'an unknown model gets reasoning headroom');
  } finally {
    api.restore();
  }
});

test('a refusal and a cut-off answer fall back locally with their own classes', async () => {
  for (const [reply, code] of [
    [{ stop_reason: 'refusal', content: [], usage: { input_tokens: 5, output_tokens: 0 } }, 'refusal'],
    [{ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"folders":[' }], usage: { input_tokens: 5, output_tokens: 9 } }, 'max_tokens']
  ]) {
    const tabs = makeTabs(960, 96000);
    installBrowser(tabs);
    setPermission(true);
    const api = installAnthropic({ reply: () => reply });
    const warn = console.warn;
    console.warn = () => {};
    try {
      const result = await executeTabGrouping(960, ANTHROPIC);
      assert.equal(result.fallbackUsed, true);
      assert.equal(result.fallbackCode, code);
      assert.ok(result.groupsCreated > 0, 'the cleanup ran locally');
    } finally {
      console.warn = warn;
      api.restore();
    }
  }
});

test('requestProviderHostAccess asks Chrome synchronously for Anthropic only', async () => {
  const asked = [];
  const permissions = { request(query) { asked.push(query); return Promise.resolve(true); } };
  const pending = requestProviderHostAccess('anthropic', permissions);
  assert.equal(asked.length, 1, 'the request is made before any await');
  assert.deepEqual(asked[0], { origins: ['https://api.anthropic.com/*'] });
  assert.equal(await pending, true);
  assert.equal(await requestProviderHostAccess('openai', permissions), true);
  assert.equal(asked.length, 1, 'engines with install-time hosts never ask');
  assert.equal(await requestProviderHostAccess('anthropic', { request: () => Promise.reject(new Error('no')) }), false);
  assert.equal(await requestProviderHostAccess('anthropic', { request() { throw new Error('no'); } }), false);
});

test('M1: the grant is checked before every catalogue page and before the compatibility retry', async () => {
  installBrowser([]);
  // Catalogue: access is there for page 1, gone before page 2.
  const checks = setPermission(count => count <= 1);
  const pages = [
    { data: [{ type: 'model', id: 'claude-test-alpha' }], has_more: true, last_id: 'claude-test-alpha' },
    { data: [{ type: 'model', id: 'claude-opus-5-5' }], has_more: false, last_id: 'claude-opus-5-5' }
  ];
  const catalogue = installAnthropic({ reply: () => pages.shift() });
  try {
    await assert.rejects(listProviderModels('anthropic', { apiKey: KEY }), error => error.code === 'permission');
    assert.equal(catalogue.requests.length, 1, 'page 2 is never requested without access');
    assert.equal(checks.length, 2, 'one check per page');
  } finally {
    catalogue.restore();
  }

  // Plan: access is there for the first POST; the effort rejection comes back; access is gone before the retry.
  registerAnthropicModelProfile({ model: 'claude-effort-m1', ...EFFORT_ONLY });
  setPermission(count => count <= 1);
  const plan = installAnthropic({ fail: payload => (payload.output_config?.effort ? { message: 'rejected', param: 'output_config.effort' } : null) });
  try {
    await assert.rejects(
      planWindowWithCloud(rows, 2, { ...ANTHROPIC, anthropicModel: 'claude-effort-m1' }, { recordUsage: false }),
      error => error.code === 'permission'
    );
    assert.equal(plan.requests.length, 1, 'the retry with the key and rows is not sent');
  } finally {
    plan.restore();
  }

  // A cleanup that loses access mid-way says the request may already have been sent.
  const tabs = makeTabs(970, 97000);
  installBrowser(tabs);
  registerAnthropicModelProfile({ model: 'claude-effort-m1', ...EFFORT_ONLY });
  setPermission(count => count <= 1);
  const cleanup = installAnthropic({ fail: payload => (payload.output_config?.effort ? { message: 'rejected', param: 'output_config.effort' } : null) });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const result = await executeTabGrouping(970, { ...ANTHROPIC, anthropicModel: 'claude-effort-m1' });
    assert.equal(cleanup.requests.length, 1);
    assert.equal(result.fallbackCode, 'permission');
    assert.match(result.message, /withdrawn while the request was running/);
    assert.doesNotMatch(result.message, /nothing was sent/);
  } finally {
    console.warn = warn;
    cleanup.restore();
  }
});

test('M2: a failed Anthropic response, an unreadable body and a bad header carry no provider text and no key fragment', async () => {
  installBrowser([]);
  setPermission(true);
  const secret = 'sk-ant-api03-SYNTHETICKEYMATERIAL0123456789abcdef';
  const echoed = `invalid x-api-key ${secret} near "Tokyo hotel" in row 2`;
  const settings = { provider: 'anthropic', anthropicApiKey: secret, groupingStrategy: 'task' };
  const leaks = error => {
    const text = JSON.stringify({ ...error, message: error.message, stack: undefined });
    return /SYNTHETICKEY|ant-api03|Tokyo hotel|invalid x-api-key|near/i.test(text) || secret.split('').some((_, index) => index + 8 <= secret.length && text.includes(secret.slice(index, index + 8)));
  };
  const original = globalThis.fetch;
  try {
    // A 400 that quotes the key and a row, on the Messages endpoint and the Models endpoint.
    const quoting = installAnthropic({ fail: () => echoed });
    try {
      await assert.rejects(planWindowWithCloud(rows, 2, settings, { recordUsage: false }), error => {
        assert.equal(error.status, 400);
        assert.equal(error.message, 'Anthropic · Claude API HTTP 400 (invalid request)');
        assert.equal(leaks(error), false, JSON.stringify(error));
        return true;
      });
    } finally {
      quoting.restore();
    }
    globalThis.fetch = async () => ({ ok: false, status: 401, statusText: echoed, async json() { return { error: { message: echoed } }; } });
    for (const attempt of [
      () => listProviderModels('anthropic', { apiKey: secret }),
      () => planWindowWithCloud(rows, 2, settings, { recordUsage: false })
    ]) {
      await assert.rejects(attempt(), error => {
        assert.equal(error.status, 401);
        assert.match(error.message, /^Anthropic · Claude API HTTP 401 \(authentication failed\)$/);
        assert.equal(leaks(error), false);
        return true;
      });
    }
    // A 200 whose body does not parse (a SyntaxError quotes a clip of it), and a Fetch header TypeError quoting the key.
    globalThis.fetch = async () => ({ ok: true, status: 200, async json() { throw new SyntaxError(`Unexpected token in "${echoed}"`); } });
    for (const attempt of [
      () => listProviderModels('anthropic', { apiKey: secret }),
      () => planWindowWithCloud(rows, 2, settings, { recordUsage: false })
    ]) {
      await assert.rejects(attempt(), error => {
        assert.equal(error.message, 'Anthropic · Claude response could not be read');
        assert.equal(leaks(error), false);
        return true;
      });
    }
    globalThis.fetch = async () => { throw new TypeError(`Headers.append: "${secret}" is an invalid header value.`); };
    for (const attempt of [
      () => listProviderModels('anthropic', { apiKey: secret }),
      () => planWindowWithCloud(rows, 2, settings, { recordUsage: false })
    ]) {
      await assert.rejects(attempt(), error => {
        assert.equal(error.message, 'Anthropic · Claude request failed');
        assert.equal(leaks(error), false);
        return true;
      });
    }
  } finally {
    globalThis.fetch = original;
  }
});

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
function runEngineScript(args, key) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'foldnex-run-engine-'));
  try {
    const run = spawnSync(process.execPath, [path.join(REPO, 'eval/run-engine.mjs'), '--engine', 'anthropic', '--stub', '--windows', 'b-move', '--repeats', '1', '--out', out, ...args], {
      env: { ...process.env, ANTHROPIC_API_KEY: key }, encoding: 'utf8'
    });
    const files = fs.readdirSync(out).map(name => fs.readFileSync(path.join(out, name), 'utf8'));
    return { status: run.status, output: `${run.stdout}\n${run.stderr}`, files };
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

test('M2: the evaluation runner logs a safe code and status, with no key fragment or provider text', () => {
  const secret = 'sk-ant-api03-EVALSYNTHETICMATERIAL0123456789abcdefghij';
  const run = runEngineScript(['--stub-fail'], secret);
  assert.equal(run.status, 0, run.output);
  assert.equal(run.files.length, 1);
  const record = JSON.parse(run.files[0]);
  const request = record.units[0].requests[0];
  assert.equal(request.status, 400);
  assert.equal(request.error_code, 'http_400');
  assert.equal(request.error, 'Anthropic · Claude API HTTP 400 (invalid request)');
  for (const text of [run.output, run.files[0]]) {
    assert.doesNotMatch(text, /EVALSYNTHETIC|ant-api03|stub: bad request/);
    for (let index = 0; index + 8 <= secret.length; index++) assert.equal(text.includes(secret.slice(index, index + 8)), false, secret.slice(index, index + 8));
  }
});

test('M3: a run whose first window could pass the cap sends nothing; a roomy cap runs', () => {
  const prices = ['--price-in', '5', '--price-out', '25'];
  const capped = runEngineScript([...prices, '--max-cost', '0.001'], 'stub-key');
  assert.equal(capped.status, 0, capped.output);
  assert.match(capped.output, /Stopping: window b-move could take the run past the 0\.001 USD cap/);
  assert.match(capped.output, /stub saw 0 request\(s\)/);
  assert.equal(capped.files.length, 0, 'no unit was run');
  const roomy = runEngineScript([...prices, '--max-cost', '5'], 'stub-key');
  assert.equal(roomy.status, 0, roomy.output);
  assert.match(roomy.output, /stub saw 1 request\(s\)/);
  assert.doesNotMatch(roomy.output, /Stopping/);
});

test('L2: a rejected effort parameter wins over a message that mentions structured output', async () => {
  installBrowser([]);
  setPermission(true);
  registerAnthropicModelProfile({ model: 'claude-effort-l2', ...EFFORT_ONLY });
  const settings = { ...ANTHROPIC, anthropicModel: 'claude-effort-l2' };
  const api = installAnthropic({ fail: payload => (payload.output_config?.effort
    ? { message: 'This value is not supported when structured output is requested', param: 'output_config.effort' }
    : null) });
  try {
    const first = await planWindowWithCloud(rows, 2, settings);
    assert.equal(api.requests.length, 2, 'the effort-less retry went out');
    assert.equal(api.requests[1].payload.output_config.format.type, 'json_schema', 'the schema stays');
    assert.equal(api.requests[1].payload.output_config.effort, undefined);
    assert.ok(first.json);
    await planWindowWithCloud(rows, 2, settings);
    assert.equal(api.requests[2].payload.output_config.format.type, 'json_schema', 'no JSON mode was remembered');
    // Without a parameter path the text decides, as before.
    const textOnly = installAnthropic({ fail: payload => (payload.output_config?.format ? 'output_config.format.schema is not supported' : null) });
    try {
      await assert.rejects(planWindowWithCloud(rows, 2, { ...settings, anthropicModel: 'claude-format-l2' }), error => error.schemaRejected === true);
    } finally {
      textOnly.restore();
    }
  } finally {
    api.restore();
  }
});

test('L3: every settings load replaces the stored profile, an absent record included; catalogue profiles stay page-local', async () => {
  const { local } = installBrowser([]);
  local[ANTHROPIC_PROFILE_KEY] = { model: 'claude-l3-model', efforts: ['low', 'high'], off: 'disabled' };
  await loadSettings();
  assert.deepEqual([...getReasoningEffortOptions('anthropic', 'claude-l3-model')], ['none', 'low', 'high']);
  const withProfile = planRequestBudget(rows.length, 'low', false);
  assert.ok(withProfile > 0);
  delete local[ANTHROPIC_PROFILE_KEY];
  await loadSettings();
  assert.deepEqual([...getReasoningEffortOptions('anthropic', 'claude-l3-model')], [], 'the running context drops it with the stored record');
  assert.equal(anthropicStoredProfile('claude-l3-model'), null);
});

test('L3: a catalogue answered for the page is published only when the page says it is current', async () => {
  installBrowser([]);
  setPermission(true);
  const api = installAnthropic({ reply: () => ({ data: [{ type: 'model', id: 'claude-l3-listed', capabilities: { effort: { supported: true, low: { supported: true } }, thinking: { types: { disabled: { supported: true } } } } }], has_more: false, last_id: 'claude-l3-listed' }) });
  try {
    let held = null;
    await listProviderModels('anthropic', { apiKey: KEY, onProfiles: profiles => { held = profiles; } });
    assert.deepEqual([...getReasoningEffortOptions('anthropic', 'claude-l3-listed')], [], 'a stale or unaccepted listing publishes nothing');
    publishAnthropicCatalogProfiles(held);
    assert.deepEqual([...getReasoningEffortOptions('anthropic', 'claude-l3-listed')], ['none', 'low']);
  } finally {
    api.restore();
  }
});

test('L4: the documents that state the one-request limit also disclose the Anthropic compatibility retry', () => {
  for (const file of ['README.md', 'docs/user-guide.md', 'docs/legal/privacy.md', 'docs/legal/terms.md', 'docs/development/chromewebstore.md', 'docs/architecture/product.md']) {
    const text = fs.readFileSync(path.join(REPO, file), 'utf8');
    assert.match(text, /Anthropic[^.]{0,200}(?:HTTP 400)/, `${file} names the retry and its trigger`);
  }
});
