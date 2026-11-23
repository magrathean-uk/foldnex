import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compactUrlHint,
  listProviderModels,
  planWindowWithCloud,
  requestProviderJson,
  resolveProviderEndpoint
} from '../src/ai-engine.js';
import { enforcePlan } from '../src/planner.js';
import { executeTabGrouping } from '../src/grouper.js';
import { installBrowser, installProvider, makeTabs, OPENAI } from './plan-harness.js';

function installStorage() {
  const area = store => ({
    async get(keys) {
      if (keys == null) return structuredClone(store);
      return Object.fromEntries([].concat(keys).filter(key => key in store).map(key => [key, structuredClone(store[key])]));
    },
    async set(values) { Object.assign(store, structuredClone(values)); },
    async remove(keys) { for (const key of [].concat(keys)) delete store[key]; }
  });
  globalThis.chrome = { storage: { local: area({}), sync: area({}), session: area({}) } };
}

/** Records every request; answers a catalog GET or a plan POST with an ordinary body. */
function captureFetch(answer = () => ({ folders: [] }), extra = {}) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const body = options.body ? JSON.parse(options.body) : null;
    return {
      ok: true,
      async json() {
        if (!body) return { data: [{ id: 'model-a' }], models: [{ name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }] };
        if (body.contents) return { candidates: [{ content: { parts: [{ text: JSON.stringify(answer()) }] } }] };
        return { model: extra.echoModel ?? body.model, choices: [{ message: { content: JSON.stringify(answer()) } }] };
      }
    };
  };
  return { requests, restore() { globalThis.fetch = original; } };
}

const rows = [
  { id: 1, title: 'React hooks reference', url: 'https://react.example/reference' },
  { id: 2, title: 'Tokyo hotel', url: 'https://travel.example/tokyo' }
];

test('M1: a saved or synced endpoint never pairs a fixed provider key with another host', async () => {
  installStorage();
  const fetchLog = captureFetch();
  try {
    await listProviderModels('openai', { apiKey: 'synthetic-key', baseUrl: 'https://attacker.example/v1' });
    await requestProviderJson({
      provider: 'openai', openaiApiKey: 'synthetic-key', openaiBaseUrl: 'https://attacker.example/v1'
    }, { system: 's', user: 'u', recordUsage: false });
    await planWindowWithCloud(rows, 2, {
      provider: 'groq', groqApiKey: 'synthetic-key', groqBaseUrl: 'https://attacker.example/openai/v1'
    }, { recordUsage: false });
    assert.deepEqual(fetchLog.requests.map(request => new URL(request.url).origin), [
      'https://api.openai.com', 'https://api.openai.com', 'https://api.groq.com'
    ]);
  } finally {
    fetchLog.restore();
  }
});

test('M1: an Ollama endpoint with userinfo, query or fragment, or plain HTTP off loopback, sends nothing', async () => {
  installStorage();
  const fetchLog = captureFetch();
  try {
    for (const baseUrl of [
      'http://user:secret@localhost:11434/v1',
      'https://@ollama.example.com/v1',
      'http://@localhost:11434/v1',
      'https://:@ollama.example.com/v1',
      'http://localhost:11434/v1?token=synthetic',
      'http://localhost:11434/v1#frag',
      'http://ollama.example:11434/v1',
      'not a url'
    ]) {
      await assert.rejects(listProviderModels('ollama', { baseUrl }), /endpoint/i, baseUrl);
      await assert.rejects(planWindowWithCloud(rows, 2, { provider: 'ollama', ollamaBaseUrl: baseUrl }, { recordUsage: false }), /endpoint/i, baseUrl);
    }
    assert.equal(fetchLog.requests.length, 0);
    assert.equal(resolveProviderEndpoint('ollama', 'https://ollama.example/v1/'), 'https://ollama.example/v1');
    assert.equal(resolveProviderEndpoint('ollama', 'http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
    assert.equal(resolveProviderEndpoint('ollama', ''), 'http://localhost:11434/v1');
  } finally {
    fetchLog.restore();
  }
});

test('M2: every provider request refuses to follow a redirect', async () => {
  installStorage();
  const fetchLog = captureFetch();
  try {
    await listProviderModels('gemini_api', { apiKey: 'synthetic-key' });
    await listProviderModels('openrouter', {});
    await planWindowWithCloud(rows, 2, { provider: 'gemini_api', geminiApiKey: 'synthetic-key' }, { recordUsage: false });
    await planWindowWithCloud(rows, 2, { provider: 'ollama' }, { recordUsage: false });
    assert.equal(fetchLog.requests.length, 4);
    for (const request of fetchLog.requests) assert.equal(request.options.redirect, 'error', request.url);
  } finally {
    fetchLog.restore();
  }
});

test('L1: a long identifier is masked whole even when the path is longer than the clip length', () => {
  const id = '9f8e7d6c5b4a39281706f5e4d3c2b1a0';
  const url = `https://docs.example.com/shared.drive.folder.for.team.notes/quarterly.planning.documents.2026/${id}/view?usp=sharing#top`;
  assert.equal(compactUrlHint(url), 'docs.example.com/shared.drive.folder.for.team.notes/quarterly.planning.documents.2026/:id');
  assert.equal(compactUrlHint('https://www.example.org/account/12345678/statements'), 'example.org/account/:id/statements');
  assert.equal(compactUrlHint('https://user:pass@example.org/a/b?x=1'), 'example.org/a/b');
});

test('hints: a three-segment path never yields more than 80 path characters', () => {
  const host = 'example.com';
  const segment = letter => Array.from({ length: 24 }, () => `${letter}.`).join('');
  for (const url of [
    `https://${host}/${segment('a')}/${segment('b')}/example-third-segment`,
    `https://${host}/${'x'.repeat(48)}/${'y'.repeat(48)}/${'z'.repeat(48)}`,
    `https://${host}/${'q.'.repeat(30)}/${'r.'.repeat(30)}/${'s.'.repeat(30)}/fourth`
  ]) {
    const hint = compactUrlHint(url);
    assert.ok(hint.startsWith(`${host}/`), hint);
    assert.ok(hint.length - host.length <= 80, `${hint.length - host.length}: ${hint}`);
    assert.doesNotMatch(hint, /example-third-segment|fourth/);
  }
});

test('L2: a plan answer is read only up to a budget relative to the rows sent', () => {
  const tabs = rows.map((row, index) => ({ ...row, windowId: 1, index }));
  let folderReads = 0;
  const folders = Array.from({ length: 50_000 }, () => ({ name: 'Flood', get ids() { folderReads++; return [0, 1]; } }));
  const first = enforcePlan({ folders }, tabs);
  assert.ok(folderReads <= 64, `read ${folderReads} folders`);
  assert.equal(first.groups.length, 1);

  let entryReads = 0;
  const ids = new Proxy(Array.from({ length: 200_000 }, () => 0), {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) entryReads++;
      return Reflect.get(target, key, receiver);
    }
  });
  enforcePlan({ folders: [{ name: 'Flood', ids }] }, tabs);
  assert.ok(entryReads <= 256, `read ${entryReads} entries`);
});

test('L2: the Gemini catalogue stops at a page bound and on a repeated page token', async () => {
  installStorage();
  const original = globalThis.fetch;
  let pages = 0;
  globalThis.fetch = async url => {
    pages++;
    const token = new URL(url).searchParams.get('pageToken');
    return { ok: true, async json() {
      return { models: [{ name: `models/gemini-${pages}`, supportedGenerationMethods: ['generateContent'] }],
        nextPageToken: token === 'same' ? 'same' : (pages < 1000 ? `page-${pages}` : '') };
    } };
  };
  try {
    const models = await listProviderModels('gemini_api', { apiKey: 'synthetic-key' });
    assert.ok(pages <= 20, `fetched ${pages} pages`);
    assert.equal(models.length, pages);
    pages = 0;
    globalThis.fetch = async url => {
      pages++;
      return { ok: true, async json() { return { models: [], nextPageToken: 'same' }; } };
    };
    await listProviderModels('gemini_api', { apiKey: 'synthetic-key' });
    assert.equal(pages, 2, 'a repeated token ends the loop');
  } finally {
    globalThis.fetch = original;
  }
});

test('L3: run diagnostics record the configured model, never the model name a provider returns', async () => {
  const tabs = makeTabs(901, 90100);
  const { local } = installBrowser(tabs);
  const provider = installProvider();
  const send = globalThis.fetch;
  const echo = 'echo React hooks reference synthetic-key';
  globalThis.fetch = async (url, options) => {
    const response = await send(url, options);
    return { ...response, async json() { return { ...(await response.json()), model: echo }; } };
  };
  try {
    const result = await executeTabGrouping(901, { ...OPENAI, openaiModel: 'gpt-6-luna' });
    assert.equal(result.source, 'cloud-plan');
    assert.equal(local.foldnex_last_run.model, 'gpt-6-luna');
    assert.ok(!JSON.stringify(local).includes(echo));
  } finally {
    provider.restore();
  }
});

test('L4: a placement failure logs no group name', async () => {
  const tabs = makeTabs(902, 90200, { incognito: true });
  installBrowser(tabs);
  chrome.tabs.group = async () => { throw new Error('Tabs cannot be edited right now'); };
  const logged = [];
  const saved = { warn: console.warn, error: console.error, log: console.log };
  console.warn = (...args) => logged.push(args.map(String).join(' '));
  console.error = console.warn;
  console.log = console.warn;
  try {
    const result = await executeTabGrouping(902, { provider: 'offline', groupingStrategy: 'task' });
    assert.ok(logged.some(line => /group/i.test(line)), 'the failure is still logged');
    const names = (result.groups || []).map(group => group.name).filter(Boolean);
    assert.ok(names.length > 0);
    for (const name of names) assert.ok(!logged.some(line => line.includes(name)), `"${name}" in the log`);
  } finally {
    Object.assign(console, saved);
  }
});
