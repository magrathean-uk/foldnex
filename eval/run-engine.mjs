// Measures a product engine on the grouping fixtures through the product's own request path:
// the plan request goes through the product's planWindowWithCloud (src/ai-engine.js: prompt, schema,
// output budget and timeout as shipped) with usage recording off. One request at a time. No retries of ours; the
// product's own single JSON-mode retry after a rejected schema is counted in http_attempts.
// Writes one run file per variant in the unit format of run-provider.mjs, into results/provider/phase1
// by default (a --stub run goes to a temporary directory), so report-phase1.mjs reads it.
// Not product code. Run with --help for the options and the key variable of each engine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_GROUPS, PROVIDER_CATALOG, providerSettingKey, planWindowWithCloud } from '../src/ai-engine.js';
import { loadWindows } from './lib.mjs';
import { makeUnit, planOutputBudget, stabilityOf, stamp, writeRun } from './phase1-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(HERE, 'results', 'provider', 'phase1');

// The key of each engine comes only from this variable. It is never printed or stored.
export const KEY_ENV = {
  openai: 'OPENAI_API_KEY',
  gemini_api: 'GEMINI_API_KEY',
  xai: 'XAI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  ollama: 'OLLAMA_API_KEY (optional; a local server needs none)'
};
const envName = engine => KEY_ENV[engine].split(' ')[0];

const HELP = `Usage: node eval/run-engine.mjs --engine <engine> [options]

  --engine <id>        ${Object.keys(KEY_ENV).join(' | ')}
  --model <id>         default: the engine's defaultModel in PROVIDER_CATALOG
  --windows <list>     comma separated fixture windows (default: all twelve)
  --repeats <n>        default 2
  --effort <value>     the saved reasoning effort the product would use (default: the product's own default)
  --priority on|off|both   OpenAI service tier, as the product sets it (default on; both interleaves the two)
  --base-url <url>     override the engine's base URL (a remote Ollama, for example)
  --price-in <usd>     USD per million input tokens; with --price-out, cost is reported in USD (never assumed)
  --price-out <usd>    USD per million output tokens (reasoning tokens counted as output)
  --out <dir>          default eval/results/provider/phase1 (--stub: a temporary directory)
  --stub               no network: fetch is replaced by a local function answering in each provider's shape

Key variables (read from the environment only):
${Object.entries(KEY_ENV).map(([engine, name]) => `  ${engine.padEnd(11)} ${name}`).join('\n')}
`;

function parseArgs(argv) {
  const options = { engine: '', model: '', windows: 'all', repeats: 2, effort: '', priority: 'on', baseUrl: '', priceIn: null, priceOut: null, out: '', stub: false };
  const names = { '--engine': 'engine', '--model': 'model', '--windows': 'windows', '--repeats': 'repeats', '--effort': 'effort', '--priority': 'priority', '--base-url': 'baseUrl', '--price-in': 'priceIn', '--price-out': 'priceOut', '--out': 'out' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') { console.log(HELP); process.exit(0); }
    else if (argv[i] === '--stub') options.stub = true;
    else if (names[argv[i]]) options[names[argv[i]]] = argv[++i];
    else throw new Error(`Unknown option ${argv[i]}`);
  }
  if (!KEY_ENV[options.engine]) throw new Error(`--engine must be one of ${Object.keys(KEY_ENV).join(', ')}`);
  if (!['on', 'off', 'both'].includes(options.priority)) throw new Error('--priority must be on, off or both');
  if (options.priority !== 'on' && options.engine !== 'openai') throw new Error('--priority applies to the openai engine only');
  options.repeats = Math.max(1, Number(options.repeats) || 1);
  options.model = options.model || PROVIDER_CATALOG[options.engine].defaultModel;
  for (const key of ['priceIn', 'priceOut']) {
    if (options[key] !== null) {
      options[key] = Number(options[key]);
      if (!Number.isFinite(options[key]) || options[key] < 0) throw new Error(`--${key === 'priceIn' ? 'price-in' : 'price-out'} must be a number of USD per million tokens`);
    }
  }
  if ((options.priceIn === null) !== (options.priceOut === null)) throw new Error('Give both --price-in and --price-out, or neither');
  options.out = options.out || (options.stub ? path.join(os.tmpdir(), `foldnex-eval-stub-${options.engine}`) : DEFAULT_OUT);
  return options;
}

/** The product's saved settings for one engine run: the same keys resolveProviderRequest reads. */
function settingsFor(options, apiKey, priority) {
  const { engine } = options;
  const settings = { provider: engine };
  if (engine === 'gemini_api') {
    settings.geminiApiKey = apiKey;
    settings.geminiModel = options.model;
    if (options.effort) settings.geminiReasoningEffort = options.effort;
    return settings;
  }
  settings[providerSettingKey(engine, 'apiKey')] = apiKey;
  settings[providerSettingKey(engine, 'model')] = options.model;
  if (options.baseUrl) settings[providerSettingKey(engine, 'baseUrl')] = options.baseUrl;
  if (options.effort) settings[providerSettingKey(engine, 'reasoningEffort')] = options.effort;
  if (engine === 'openai') settings.openaiPriority = priority !== 'off'; // the product sends priority unless turned off
  return settings;
}


// --- stub fetch --------------------------------------------------------------------------------

/** A valid plan for rows [[id, title, hint], ...]: the largest sites become folders, the rest Review Later. */
function stubPlan(rows) {
  const bySite = new Map();
  for (const [id, , hint] of rows) {
    const site = String(hint || '-').split('/')[0] || '-';
    if (!bySite.has(site)) bySite.set(site, []);
    bySite.get(site).push(id);
  }
  const ranked = [...bySite].sort((a, b) => b[1].length - a[1].length);
  const folders = ranked.slice(0, 8).filter(([, ids]) => ids.length >= 2)
    .map(([site, ids]) => ({ name: site.replace(/^www\./, '').split('.')[0].replace(/^./, c => c.toUpperCase()) || 'Folder', ids }));
  const used = new Set(folders.flatMap(folder => folder.ids));
  const rest = rows.map(row => row[0]).filter(id => !used.has(id));
  if (rest.length) folders.push({ name: 'Review Later', ids: rest });
  return { folders };
}

const tabRowsIn = text => {
  const line = String(text).split('\n').find(candidate => candidate.startsWith('{"tabs":'));
  return line ? JSON.parse(line).tabs : null;
};

/** Replaces fetch for the engine run; returns {fetch, seen}. It checks the request shape of each provider before answering. */
function makeStubFetch(options, apiKey) {
  const seen = [];
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const stubFetch = async (url, init = {}) => {
    const body = JSON.parse(init.body);
    const headers = init.headers || {};
    const note = { url: String(url), method: init.method };
    seen.push(note);
    if (options.engine === 'gemini_api') {
      const expected = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(options.model)}:generateContent`;
      if (String(url) !== expected) return reply(404, { error: { message: `stub: unexpected URL ${url}` } });
      if (headers['x-goog-api-key'] !== apiKey) return reply(401, { error: { message: 'stub: missing x-goog-api-key' } });
      const text = body.contents?.[0]?.parts?.[0]?.text;
      const rows = tabRowsIn(text);
      if (!rows || body.generationConfig?.responseMimeType !== 'application/json' || !body.generationConfig?.responseSchema?.properties?.folders) {
        return reply(400, { error: { message: 'stub: not a plan request in the Gemini shape' } });
      }
      note.shape = 'gemini generateContent, responseSchema folders';
      const answer = JSON.stringify(stubPlan(rows));
      const promptTokens = Math.ceil((JSON.stringify(body.system_instruction).length + text.length) / 4);
      return reply(200, {
        candidates: [{ content: { parts: [{ text: answer }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: Math.ceil(answer.length / 4), thoughtsTokenCount: 0, totalTokenCount: promptTokens + Math.ceil(answer.length / 4) }
      });
    }
    const base = String(options.baseUrl || PROVIDER_CATALOG[options.engine].baseUrl).replace(/\/+$/, '');
    if (String(url) !== `${base}/chat/completions`) return reply(404, { error: { message: `stub: unexpected URL ${url}` } });
    const keyOptional = PROVIDER_CATALOG[options.engine].keyOptional;
    if (!keyOptional && headers.Authorization !== `Bearer ${apiKey}`) return reply(401, { error: { message: 'stub: missing bearer key' } });
    if (body.model !== options.model || !Array.isArray(body.messages)) return reply(400, { error: { message: 'stub: model or messages missing' } });
    const rows = body.messages.map(message => tabRowsIn(message.content)).find(Boolean);
    if (!rows) return reply(400, { error: { message: 'stub: not a plan request' } });
    note.shape = `chat/completions, response_format ${body.response_format?.type}${body.service_tier ? `, service_tier ${body.service_tier}` : ''}`;
    const answer = JSON.stringify(stubPlan(rows));
    const promptTokens = Math.ceil(body.messages.reduce((sum, message) => sum + String(message.content).length, 0) / 4);
    return reply(200, {
      model: body.model,
      service_tier: body.service_tier,
      choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
      usage: { prompt_tokens: promptTokens, completion_tokens: Math.ceil(answer.length / 4), total_tokens: promptTokens + Math.ceil(answer.length / 4), completion_tokens_details: { reasoning_tokens: 0 } }
    });
  };
  return { fetch: stubFetch, seen };
}

// --- run ---------------------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { engine } = options;
  const config = PROVIDER_CATALOG[engine];
  const apiKey = options.stub ? 'stub-key' : (process.env[envName(engine)] || '');
  if (!apiKey && !config.keyOptional) throw new Error(`${envName(engine)} is not set`);
  const redact = text => (apiKey ? String(text).split(apiKey).join('[key]') : String(text));

  const all = await loadWindows();
  const names = options.windows === 'all' ? Object.keys(all) : options.windows.split(',').map(name => name.trim());
  for (const name of names) if (!all[name]) throw new Error(`Unknown window "${name}". Have: ${Object.keys(all).join(', ')}`);
  const variants = engine === 'openai' ? (options.priority === 'both' ? ['on', 'off'] : [options.priority]) : [null];

  // Count the HTTP attempts the product makes per request, over the real or the stubbed fetch.
  const underlying = options.stub ? makeStubFetch(options, apiKey) : { fetch: globalThis.fetch.bind(globalThis), seen: [] };
  let attempts = 0;
  globalThis.fetch = (...args) => { attempts++; return underlying.fetch(...args); };

  const unitsByVariant = new Map(variants.map(v => [v, []]));
  const started = stamp();
  let interrupted = false;
  process.once('SIGINT', () => { interrupted = true; console.log('\nInterrupt: finishing the request in flight, then writing what exists'); });
  const total = names.length * options.repeats * variants.length;
  let position = 0;
  let effortSeen = null;
  let modelSeen = null;
  let spentUsd = 0;
  const priced = options.priceIn !== null;

  outer: for (let repeat = 0; repeat < options.repeats; repeat++) {
    for (let windowIndex = 0; windowIndex < names.length; windowIndex++) {
      const first = (repeat * names.length + windowIndex) % variants.length;
      for (let rank = 0; rank < variants.length; rank++) {
        if (interrupted) break outer;
        const variant = variants[(first + rank) % variants.length];
        const name = names[windowIndex];
        const tabs = all[name];
        attempts = 0;
        const t0 = performance.now();
        let response = null;
        let error = null;
        try {
          // The product's own plan request (prompt, schema, output budget, timeout), usage recording off.
          const planned = await planWindowWithCloud(tabs, MAX_GROUPS, settingsFor(options, apiKey, variant), { recordUsage: false });
          response = { json: planned.json, ...planned.meta };
        } catch (caught) {
          error = caught;
        }
        const outer = Math.round(performance.now() - t0);
        const answer = response?.json ?? null;
        const failed = Boolean(error) || !Array.isArray(answer?.folders);
        const usage = response?.usage || null;
        const input = usage ? usage.promptTokens : null;
        // Gemini's candidate count leaves thoughts out; the others include reasoning in completion tokens.
        const output = usage ? usage.completionTokens + (engine === 'gemini_api' ? usage.reasoningTokens || 0 : 0) : null;
        const cost = priced && usage ? ((input || 0) * options.priceIn + (output || 0) * options.priceOut) / 1e6 : null;
        if (cost !== null) spentUsd += cost;
        if (response?.reasoningEffort && !effortSeen) effortSeen = response.reasoningEffort;
        if (response?.model && !modelSeen) modelSeen = response.model;
        const request = {
          ok: !failed, status: error?.status ?? (error ? null : 200),
          error: error ? redact(error.message || error).slice(0, 600) : (failed ? 'answer is not {"folders": [...]}' : null),
          wall_ms: response?.latencyMs ?? outer, http_attempts: attempts,
          input_tokens: input, output_tokens: output, thinking_tokens: usage?.reasoningTokens ?? null, cache_read_tokens: usage?.cachedTokens ?? null,
          sent: { note: `${engine} through planWindowWithCloud`, model: response?.model || options.model, reasoning_effort: response?.reasoningEffort ?? null, service_tier: engine === 'openai' ? (variant === 'off' ? 'default' : 'priority') : null, output_budget_requested: planOutputBudget(tabs.length) }
        };
        const unit = makeUnit({
          window: name, repeat, tabs, answer, failed, wall_ms: request.wall_ms,
          input_tokens: input, output_tokens: output, thinking_tokens: usage?.reasoningTokens ?? null, cost_usd: cost, request,
          extra: { ...(variant ? { priority: variant } : {}), schedule: { position: ++position, of: total, window_index: windowIndex, rank, at: new Date().toISOString() } }
        });
        unitsByVariant.get(variant).push(unit);
        console.log(`${String(position).padStart(3)}/${total} ${name.padEnd(12)} #${repeat}${variant ? ` priority ${variant}` : ''} ${failed ? 'FAILED' : 'ok    '} F1 ${unit.score.f1.toFixed(2)} ${request.wall_ms}ms in ${input ?? '-'} out ${output ?? '-'} tok${cost === null ? '' : ` $${cost.toFixed(5)}`}`);
        if (request.error) console.log(`    error: ${request.status ?? ''} ${request.error}`);
      }
    }
  }

  const files = [];
  for (const variant of variants) {
    const units = unitsByVariant.get(variant);
    if (!units.length) continue;
    const stem = `${engine}_${options.model.replace(/[^A-Za-z0-9.-]+/g, '-')}_plan${variant ? `_priority-${variant}` : ''}`;
    files.push(writeRun(options.out, `${stem}_${started}.json`, {
      started, engine, provider: engine, model: options.model, model_returned: modelSeen, mode: 'plan', thinking: 'default', effort: effortSeen,
      ...(variant ? { priority: variant } : {}), stub: options.stub, windows: names, repeats: options.repeats, matrix: false,
      plan_example_name: units[0].plan_example_name, prices_usd_per_million: priced ? { input: options.priceIn, output: options.priceOut } : null,
      cost_usd: priced ? units.reduce((sum, unit) => sum + (unit.cost_usd || 0), 0) : null,
      stopped_early: units.length < names.length * options.repeats, stability: stabilityOf(units, all), units
    }));
  }
  files.forEach(file => console.log(`wrote ${path.relative(process.cwd(), file)}`));
  if (options.stub) {
    const shapes = [...new Set(underlying.seen.map(note => `${note.method} ${note.url} -> ${note.shape || 'rejected'}`))];
    console.log(`stub saw ${underlying.seen.length} request(s):\n  ${shapes.join('\n  ')}`);
  }
  console.log(priced ? `cost $${spentUsd.toFixed(5)} at the prices given` : 'cost: tokens only (no --price-in / --price-out given)');
}

main().catch(error => { console.error(String(error?.message || error)); process.exit(1); });
