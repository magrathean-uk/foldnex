// Provider request shapes that only the per-tab label tests used to cover,
// now sent through the plan request (planWindowWithCloud) or the shared JSON
// request (requestProviderJson). The label requests themselves are gone.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPlanSystem,
  ollamaKeepAlive,
  planGeminiSchema,
  planJsonSchema,
  planWindowWithCloud,
  requestProviderJson,
  supportsOpenAIStructuredOutputs
} from '../src/ai-engine.js';

function makeTabs(count, startId = 700001) {
  const topics = [
    ['Easy ramen recipe', 'https://www.justonecookbook.com/recipes/ramen/'],
    ['Cheap flights to Tokyo', 'https://www.skyscanner.net/transport/flights/lond/tyoa/'],
    ['React hooks reference', 'https://react.dev/reference/react/hooks']
  ];
  return Array.from({ length: count }, (_, index) => {
    const [title, url] = topics[index % topics.length];
    return { id: startId + index, title: `${title} ${index}`, url: `${url}?session=secret${index}` };
  });
}

function installFetchMock(respond) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const request = { url, headers: options.headers, body: JSON.parse(options.body), signal: options.signal };
    requests.push(request);
    return respond(request, requests.length - 1);
  };
  return { requests, restore() { globalThis.fetch = original; } };
}

function chatResponse(content, model = 'gpt-6-luna') {
  return {
    ok: true,
    async json() {
      return {
        model,
        choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 64 } }
      };
    }
  };
}

function httpError(status, message, param = null) {
  return {
    ok: false,
    status,
    statusText: 'Error',
    async json() { return { error: { message, param } }; }
  };
}

const FOLDERS = { folders: [{ name: 'Japan Trip', ids: [0, 1] }] };

test('a Gemini plan request uses the folder responseSchema and the key header, and skips thought parts', async () => {
  let request;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    request = { url, headers: options.headers, body: JSON.parse(options.body) };
    return {
      ok: true,
      async json() {
        return {
          candidates: [{ content: { parts: [
            { thought: true, text: 'thinking' },
            { text: JSON.stringify(FOLDERS) }
          ] } }],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, totalTokenCount: 60, thoughtsTokenCount: 5 }
        };
      }
    };
  };
  try {
    const result = await planWindowWithCloud(makeTabs(3), 2, {
      provider: 'gemini_api',
      geminiApiKey: 'test-only',
      geminiModel: 'gemini-2.5-flash-lite'
    }, { recordUsage: false });
    assert.ok(request.url.endsWith('/models/gemini-2.5-flash-lite:generateContent'));
    assert.equal(request.headers['x-goog-api-key'], 'test-only');
    assert.equal(request.body.system_instruction.parts[0].text, buildPlanSystem(2));
    const config = request.body.generationConfig;
    assert.equal(config.responseMimeType, 'application/json');
    assert.deepEqual(config.responseSchema, planGeminiSchema());
    assert.deepEqual(result.json, FOLDERS, 'thought parts are not part of the answer');
    assert.equal(result.meta.usage.reasoningTokens, 5);
  } finally {
    globalThis.fetch = original;
  }
});

test('provider details: OpenRouter headers, a missing key and Responses-only models', async () => {
  const fetchMock = installFetchMock(request => chatResponse(FOLDERS, request.body.model));
  try {
    await planWindowWithCloud(makeTabs(2), 2, { provider: 'openrouter', openrouterApiKey: 'test-only' }, { recordUsage: false });
    assert.equal(fetchMock.requests[0].headers['X-Title'], 'Foldnex');
    assert.equal(fetchMock.requests[0].headers['HTTP-Referer'], 'https://github.com/magrathean-uk/foldnex');
    assert.equal(fetchMock.requests[0].body.response_format.type, 'json_object');

    await assert.rejects(
      planWindowWithCloud(makeTabs(2), 2, { provider: 'openai', openaiApiKey: 'test-only', openaiModel: 'gpt-5-pro' }, { recordUsage: false }),
      /requires the OpenAI Responses API/
    );
    await assert.rejects(planWindowWithCloud(makeTabs(2), 2, { provider: 'openai' }, { recordUsage: false }), /API key is not configured/);
    assert.equal(fetchMock.requests.length, 1);
  } finally {
    fetchMock.restore();
  }
});

test('OpenAI gets a strict schema only for Structured Outputs models on its own endpoint', async () => {
  const supported = [
    'gpt-6-luna', 'gpt-6-luna-2026-03-01', 'gpt-6', 'gpt-5', 'gpt-5.4-nano', 'gpt-5-mini', 'gpt-4.1', 'gpt-4.1-mini-2025-04-14',
    'gpt-4o', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20', 'gpt-4o-mini', 'gpt-4o-mini-2024-07-18',
    'o1', 'o1-2024-12-17', 'o3', 'o3-mini', 'o4-mini', 'ft:gpt-4o-2024-08-06:acme::abc123'
  ];
  const unsupported = [
    'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo', 'gpt-4o-2024-05-13', 'chatgpt-4o-latest', 'gpt-4o-audio-preview',
    'o1-mini', 'o1-preview-2024-09-12', 'gpt-4.10', 'ft:gpt-3.5-turbo-0125:acme::abc123'
  ];
  for (const model of supported) assert.equal(supportsOpenAIStructuredOutputs(model), true, model);
  for (const model of unsupported) assert.equal(supportsOpenAIStructuredOutputs(model), false, model);
  assert.equal(supportsOpenAIStructuredOutputs('gpt-6-luna', 'https://api.openai.com/v1/'), true);
  assert.equal(supportsOpenAIStructuredOutputs('gpt-6-luna', 'https://proxy.example.com/v1'), false);

  const fetchMock = installFetchMock(request => chatResponse(FOLDERS, request.body.model));
  try {
    const tabs = makeTabs(3);
    const legacy = await planWindowWithCloud(tabs, 2, { provider: 'openai', openaiApiKey: 'test-only', openaiModel: 'gpt-4-turbo' }, { recordUsage: false });
    await planWindowWithCloud(tabs, 2, { provider: 'openai', openaiApiKey: 'test-only', openaiModel: 'gpt-4.1-mini' }, { recordUsage: false });
    await planWindowWithCloud(tabs, 2, { provider: 'openai', openaiApiKey: 'test-only', openaiBaseUrl: 'https://proxy.example.com/v1/' }, { recordUsage: false });
    // A saved override never moves OpenAI off its own endpoint (D40), so the schema stays strict.
    assert.deepEqual(fetchMock.requests.map(request => request.body.response_format.type), ['json_object', 'json_schema', 'json_schema']);
    assert.deepEqual(fetchMock.requests[1].body.response_format.json_schema.schema, planJsonSchema());
    assert.equal(fetchMock.requests[2].url, 'https://api.openai.com/v1/chat/completions');
    assert.deepEqual(legacy.json, FOLDERS, 'a JSON mode answer comes back for local validation');
    assert.equal(fetchMock.requests.some(request => 'prompt_cache_key' in request.body), false);
  } finally {
    fetchMock.restore();
  }
});

test('a strict OpenAI request rejected for its response_format is retried once in JSON mode', async () => {
  const settings = { provider: 'openai', openaiApiKey: 'test-only', openaiModel: 'gpt-4o-2024-08-06' };
  const ask = () => requestProviderJson(settings, { system: 'S', user: 'U', schemaName: 'tab_folders', jsonSchema: planJsonSchema(), recordUsage: false });
  let fetchMock = installFetchMock(request => (request.body.response_format.type === 'json_schema'
    ? httpError(400, "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.", 'response_format')
    : chatResponse(FOLDERS)));
  try {
    const result = await ask();
    assert.deepEqual(fetchMock.requests.map(request => request.body.response_format.type), ['json_schema', 'json_object']);
    assert.deepEqual(result.json, FOLDERS);
  } finally {
    fetchMock.restore();
  }

  // A 400 that names only json_schema in its message is recognised too.
  fetchMock = installFetchMock(request => (request.body.response_format.type === 'json_schema'
    ? httpError(400, 'json_schema is not supported for this snapshot')
    : chatResponse(FOLDERS)));
  try {
    assert.deepEqual((await ask()).json, FOLDERS);
    assert.equal(fetchMock.requests.length, 2);
  } finally {
    fetchMock.restore();
  }

  // Any other rejection, or a JSON-mode request, is not retried.
  fetchMock = installFetchMock(() => httpError(400, 'max_completion_tokens is too large', 'max_completion_tokens'));
  try {
    await assert.rejects(ask(), /HTTP 400: max_completion_tokens/);
    assert.equal(fetchMock.requests.length, 1);
    await assert.rejects(
      requestProviderJson({ ...settings, openaiModel: 'gpt-4-turbo' }, { system: 'S', user: 'U', jsonSchema: planJsonSchema(), recordUsage: false }),
      /HTTP 400/
    );
    assert.equal(fetchMock.requests.length, 2);
  } finally {
    fetchMock.restore();
  }

  fetchMock = installFetchMock(() => httpError(500, 'response_format backend unavailable', 'response_format'));
  try {
    await assert.rejects(ask(), /HTTP 500/);
    assert.equal(fetchMock.requests.length, 1, 'only an HTTP 400 earns the JSON-mode retry');
  } finally {
    fetchMock.restore();
  }
});

test('Ollama on this device gets keep_alive from the unload setting; other servers and providers do not', async () => {
  assert.deepEqual(
    ['immediately', '2m', '5m', '15m', '60m', 'never', undefined, 'forever'].map(ollamaKeepAlive),
    [0, '2m', '5m', '15m', '60m', -1, '5m', '5m']
  );
  const fetchMock = installFetchMock(() => chatResponse(FOLDERS));
  const tabs = makeTabs(2);
  const plan = settings => planWindowWithCloud(tabs, 2, settings, { recordUsage: false });
  const lastBody = () => fetchMock.requests.at(-1).body;
  try {
    for (const [setting, expected] of [['immediately', 0], ['2m', '2m'], ['5m', '5m'], ['15m', '15m'], ['60m', '60m'], ['never', -1]]) {
      await plan({ provider: 'ollama', modelUnloadAfter: setting });
      assert.equal(fetchMock.requests.at(-1).url, 'http://localhost:11434/v1/chat/completions');
      assert.equal(lastBody().keep_alive, expected, setting);
    }

    // Unset, it is '5m'; a JSON request carries the same setting.
    await plan({ provider: 'ollama' });
    assert.equal(lastBody().keep_alive, '5m');
    await requestProviderJson({ provider: 'ollama', ollamaBaseUrl: 'http://127.0.0.1:11434/v1', modelUnloadAfter: 'never' }, { system: 'S', user: 'U', recordUsage: false });
    assert.equal(lastBody().keep_alive, -1);

    // A server elsewhere and cloud providers keep their own policy.
    await plan({ provider: 'ollama', ollamaBaseUrl: 'https://ollama.example.com/v1', modelUnloadAfter: 'never' });
    assert.equal('keep_alive' in lastBody(), false);
    await plan({ provider: 'openai', openaiApiKey: 'test-only', modelUnloadAfter: 'never' });
    assert.equal('keep_alive' in lastBody(), false);
  } finally {
    fetchMock.restore();
  }
});
