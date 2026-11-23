// Measures Claude models on the grouping fixtures through the Claude API:
//   plan   : one request for the whole window, answer {"folders":[{name, ids}]}
//   labels : today's per-tab category request, batched as the product sends it
// Records quality, latency, tokens and cost. No automatic retries.
// The plan request is the product's own (buildPlanSystem, buildPlanUser and
// planJsonSchema of src/ai-engine.js).
//
//   export ANTHROPIC_API_KEY=...   (every run spends money; --max-cost caps one run, default 1 USD)
//   node eval/run-provider.mjs --model claude-haiku-5-5 --mode plan --windows dev,life --repeats 2
//   node eval/run-provider.mjs --summary-only
//
// Phase 1 matrix: the five plan settings, interleaved, on every window.
//   node eval/run-provider.mjs --matrix --dry-run        (schedule and cost estimate, sends nothing)
//   node eval/run-provider.mjs --matrix                  (--repeats 2, --max-cost 2 USD for the whole matrix)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWindows, readPlan, score } from './lib.mjs';
import { agreement, makeUnit, meanOf, planOutputBudget, planRequest, stabilityOf, stamp, writeRun } from './phase1-lib.mjs';
import { requestMessage } from './provider-claude.mjs';
import { writeSummary } from './provider-summary.mjs';

// USD per million tokens, [input, output]. A table to check against
// https://platform.claude.com/docs/en/about-claude/pricing before quoting
// any figure from it. Haiku 5.5 is $0.50 / $2.50 for prompts over 100K tokens.
export const PRICES = {
  'claude-haiku-5-5': [0.10, 0.50],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20]
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(HERE, 'results', 'provider');
const MATRIX_OUT = path.join(DEFAULT_OUT, 'phase1');
const PHASE0_DIR = path.join(DEFAULT_OUT, 'full');

function parseArgs(argv) {
  const options = { model: 'claude-haiku-5-5', mode: 'plan', effort: '', thinking: 'off', windows: 'all', repeats: null, maxCost: null, out: null, summaryOnly: false, matrix: false, dryRun: false };
  const names = { '--model': 'model', '--mode': 'mode', '--effort': 'effort', '--thinking': 'thinking', '--windows': 'windows', '--repeats': 'repeats', '--max-cost': 'maxCost', '--out': 'out' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--summary-only') options.summaryOnly = true;
    else if (argv[i] === '--matrix') options.matrix = true;
    else if (argv[i] === '--dry-run') options.dryRun = true;
    else if (names[argv[i]]) options[names[argv[i]]] = argv[++i];
    else throw new Error(`Unknown option ${argv[i]}`);
  }
  if (options.dryRun && !options.matrix) throw new Error('--dry-run belongs to --matrix');
  options.repeats = Math.max(1, Number(options.repeats ?? (options.matrix ? 2 : 1)) || 1);
  options.maxCost = Number(options.maxCost ?? (options.matrix ? 2 : 1));
  options.out = options.out || (options.matrix ? MATRIX_OUT : DEFAULT_OUT);
  if (!['plan', 'labels'].includes(options.mode)) throw new Error('--mode must be plan or labels');
  if (!['off', 'adaptive'].includes(options.thinking)) throw new Error('--thinking must be off or adaptive');
  return options;
}

const chunk = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));
const costOf = (model, input, output) => {
  const [pi, po] = PRICES[model] || [NaN, NaN];
  return ((input || 0) * pi + (output || 0) * po) / 1e6;
};

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function runPlan(tabs, options) {
  const maxTokens = planOutputBudget(tabs.length) + (options.thinking === 'adaptive' ? 8000 : 0);
  const { system, user, schema } = planRequest(tabs);
  const request = await requestMessage({
    model: options.model, system, user, schema,
    maxTokens, thinking: options.thinking, effort: options.effort
  });
  const answer = request.ok ? parseJson(request.text) : null;
  const failed = !request.ok || !answer;
  if (!failed && !request.error) request.error = null;
  const plan = readPlan(answer, tabs);
  let invalid = 0; let duplicates = 0;
  const seen = new Set();
  for (const folder of Array.isArray(answer?.folders) ? answer.folders : []) {
    for (const id of folder?.ids || []) {
      if (!Number.isInteger(id) || id < 0 || id >= tabs.length) invalid++;
      else if (seen.has(id)) duplicates++;
      else seen.add(id);
    }
  }
  return {
    requests: [request], failed: failed || (!request.ok), answer,
    assignment: plan.assignment, groups: plan.groups.filter(g => g.tabIds.length).length,
    left_out: plan.missing.length, invalid_ids: invalid, duplicate_ids: duplicates,
    names: plan.groups.map(g => g.name), group_sizes: plan.groups.map(g => g.tabIds.length)
  };
}

async function runLabels(tabs, options) {
  // The label request reproduces a baseline of the pipeline removed in Phase 4: stops with a message when it is gone.
  const { LABEL_SYSTEM_ROWS, buildLabelPrompt, labelSchema, labelOutputBudget, parseLabelResponse, cloudLabelBatchSize, planGroups } = await import('./legacy-labels.mjs');
  const size = cloudLabelBatchSize(tabs.length);
  const batches = chunk(tabs, size);
  const requests = await Promise.all(batches.map(batch => requestMessage({
    model: options.model, system: LABEL_SYSTEM_ROWS, user: buildLabelPrompt(batch, 'rows'), schema: labelSchema(batch.length, 'enum'),
    maxTokens: labelOutputBudget(batch.length) + (options.thinking === 'adaptive' ? 8000 : 0), thinking: options.thinking, effort: options.effort
  })));
  const byId = new Map();
  const answers = [];
  let entries = 0;
  requests.forEach((request, index) => {
    const answer = request.ok ? parseJson(request.text) : null;
    answers.push(answer);
    if (!answer) return;
    entries += Object.keys(answer).length;
    for (const [ordinal, key] of parseLabelResponse(answer, batches[index].length)) byId.set(batches[index][ordinal].id, key);
  });
  const failed = requests.some(request => !request.ok) || answers.some(answer => !answer);
  const plan = planGroups(tabs, byId, { locked: [] });
  const assignment = new Map(plan.groups.flatMap((group, index) => group.tabIds.map(id => [id, index])));
  return {
    requests, failed, answer: answers, assignment, groups: plan.groups.length,
    left_out: tabs.length - byId.size, invalid_ids: entries - byId.size, duplicate_ids: 0,
    label_accuracy: tabs.filter(tab => byId.get(tab.id) === tab.cat).length / tabs.length,
    batches: batches.length, names: plan.groups.map(g => g.name), group_sizes: plan.groups.map(g => g.tabIds.length)
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.matrix) return runMatrix(options);
  fs.mkdirSync(options.out, { recursive: true });
  if (options.summaryOnly) { writeSummary(options.out); console.log(`wrote ${path.join(options.out, 'summary.md')}`); return; }
  if (!PRICES[options.model]) console.warn(`No price for ${options.model}: cost will be NaN and --max-cost cannot hold`);
  const all = await loadWindows();
  const names = options.windows === 'all' ? Object.keys(all) : options.windows.split(',').map(name => name.trim());
  for (const name of names) if (!all[name]) throw new Error(`Unknown window "${name}". Have: ${Object.keys(all).join(', ')}`);

  const units = [];
  const assignments = new Map(); // window -> [assignment per repeat]
  let spent = 0;
  let lastUnitCost = 0;
  let stopped = false;
  outer: for (let repeat = 0; repeat < options.repeats; repeat++) {
    for (const name of names) {
      if (spent + lastUnitCost > options.maxCost) { stopped = true; break outer; }
      const tabs = all[name];
      const started = performance.now();
      const result = options.mode === 'plan' ? await runPlan(tabs, options) : await runLabels(tabs, options);
      const wall = Math.round(performance.now() - started);
      const input = result.requests.reduce((sum, r) => sum + (r.input_tokens || 0), 0);
      const output = result.requests.reduce((sum, r) => sum + (r.output_tokens || 0), 0);
      const thinkingTokens = result.requests.reduce((sum, r) => sum + (r.thinking_tokens || 0), 0);
      const cost = costOf(options.model, input, output);
      spent += cost; lastUnitCost = cost;
      const unit = {
        window: name, repeat, tabs: tabs.length, failed: result.failed, wall_ms: wall,
        input_tokens: input, output_tokens: output, thinking_tokens: thinkingTokens, cost_usd: cost,
        score: score(result.assignment, tabs), groups: result.groups, left_out: result.left_out,
        invalid_ids: result.invalid_ids, duplicate_ids: result.duplicate_ids,
        ...(result.label_accuracy === undefined ? {} : { label_accuracy: result.label_accuracy, batches: result.batches }),
        group_names: result.names, group_sizes: result.group_sizes,
        requests: result.requests.map(({ text, ...rest }) => rest), answer: result.answer
      };
      units.push(unit);
      if (!result.failed) {
        if (!assignments.has(name)) assignments.set(name, []);
        assignments.get(name).push({ repeat, assignment: result.assignment });
      }
      console.log(`${name.padEnd(10)} #${repeat} ${options.mode.padEnd(6)} ${result.failed ? 'FAILED ' : 'ok     '} F1 ${unit.score.f1.toFixed(2)} P ${unit.score.p.toFixed(2)} R ${unit.score.r.toFixed(2)} groups ${unit.groups} left-out ${unit.left_out} invalid ${unit.invalid_ids} ${wall}ms out ${output}tok cost $${cost.toFixed(5)}   running $${spent.toFixed(4)}`);
      for (const request of result.requests) if (request.error) console.log(`    request error: HTTP ${request.status} ${request.error}`);
    }
  }
  if (stopped) console.log(`Stopped before exceeding --max-cost ${options.maxCost}`);

  const stability = [];
  if (options.mode === 'plan') {
    for (const [name, runs] of assignments) {
      for (let i = 0; i < runs.length; i++) {
        for (let j = i + 1; j < runs.length; j++) {
          stability.push({ window: name, a: runs[i].repeat, b: runs[j].repeat, f1: agreement(runs[i].assignment, runs[j].assignment, all[name]) });
        }
      }
    }
  }

  const sent = units.find(unit => unit.requests[0])?.requests[0].sent || {};
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(options.out, `${options.model}_${options.mode}_${options.thinking}${options.effort ? `-${options.effort}` : ''}_${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({
    started: stamp, model: options.model, mode: options.mode, thinking: options.thinking, effort: options.effort || null,
    thinking_sent: sent.thinking ?? null, effort_sent: sent.effort ?? null, thinking_note: sent.note || null,
    windows: names, repeats: options.repeats, api_version: '2026-10-21', max_cost_usd: options.maxCost,
    cost_usd: spent, stopped_early: stopped, stability, units
  }, null, 1));
  writeSummary(options.out);

  const done = units.filter(unit => !unit.failed);
  const mean = values => values.reduce((a, b) => a + b, 0) / (values.length || 1);
  console.log(`\n${options.model} ${options.mode}  thinking ${options.thinking}  sent ${JSON.stringify({ thinking: sent.thinking, effort: sent.effort })}`);
  console.log(`window runs ${units.length}, failures ${units.length - done.length}, mean F1 ${mean(done.map(u => u.score.f1)).toFixed(2)}, mean latency ${Math.round(mean(done.map(u => u.wall_ms)))} ms, mean output ${Math.round(mean(units.map(u => u.output_tokens)))} tok`);
  if (stability.length) console.log(`plan stability (F1 between repeats): ${mean(stability.map(s => s.f1)).toFixed(2)} over ${stability.length} pair(s)`);
  console.log(`spent $${spent.toFixed(4)} -> ${path.relative(process.cwd(), file)}`);
}


// --- Phase 1 matrix ---------------------------------------------------------------------------

// The five plan settings of the plan's Phase 1. Opus cannot switch thinking off: "off" with no effort
// sends effort low and omits thinking (see provider-claude.mjs), the same row as in Phase 0.
export const MATRIX_SETTINGS = [
  { id: 'haiku-off', model: 'claude-haiku-5-5', thinking: 'off', effort: '' },
  { id: 'haiku-adaptive-low', model: 'claude-haiku-5-5', thinking: 'adaptive', effort: 'low' },
  { id: 'sonnet-off', model: 'claude-sonnet-5-5', thinking: 'off', effort: '' },
  { id: 'sonnet-adaptive-low', model: 'claude-sonnet-5-5', thinking: 'adaptive', effort: 'low' },
  { id: 'opus-low', model: 'claude-opus-5-5', thinking: 'off', effort: '' }
];

/**
 * The order of requests. A repeat walks the windows; on each window every setting runs once
 * before the next window, and the setting that goes first rotates with (repeat * windows + window).
 * One entry per request: {position, repeat, windowIndex, window, rank, setting}.
 */
export function matrixSchedule(windowNames, settings, repeats) {
  const schedule = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    windowNames.forEach((window, windowIndex) => {
      const first = (repeat * windowNames.length + windowIndex) % settings.length;
      for (let rank = 0; rank < settings.length; rank++) {
        schedule.push({ position: schedule.length, repeat, windowIndex, window, rank, setting: settings[(first + rank) % settings.length] });
      }
    });
  }
  return schedule;
}

const settingFileId = s => `${s.model}_plan_${s.thinking}${s.effort ? `-${s.effort}` : ''}`;

/** Per window mean tokens of the Phase 0 recordings of a setting, for the estimate: {window: {input, output}}. */
function phase0Tokens(setting) {
  const out = {};
  if (!fs.existsSync(PHASE0_DIR)) return out;
  for (const file of fs.readdirSync(PHASE0_DIR).filter(name => name.endsWith('.json'))) {
    const run = JSON.parse(fs.readFileSync(path.join(PHASE0_DIR, file), 'utf8'));
    if (run.mode !== 'plan' || run.model !== setting.model || run.thinking !== setting.thinking || (run.effort || '') !== setting.effort) continue;
    const byWindow = new Map();
    for (const unit of run.units) {
      if (unit.failed) continue;
      if (!byWindow.has(unit.window)) byWindow.set(unit.window, []);
      byWindow.get(unit.window).push(unit);
    }
    for (const [name, units] of byWindow) out[name] = { input: meanOf(units.map(u => u.input_tokens)), output: meanOf(units.map(u => u.output_tokens)) };
  }
  return out;
}

async function runMatrix(options) {
  const all = await loadWindows();
  const names = options.windows === 'all' ? Object.keys(all) : options.windows.split(',').map(name => name.trim());
  for (const name of names) if (!all[name]) throw new Error(`Unknown window "${name}". Have: ${Object.keys(all).join(', ')}`);
  const schedule = matrixSchedule(names, MATRIX_SETTINGS, options.repeats);
  const tokens = Object.fromEntries(MATRIX_SETTINGS.map(s => [s.id, phase0Tokens(s)]));
  const FALLBACK = { input: 4000, output: 800 };
  const estimateOf = (setting, window) => {
    const t = tokens[setting.id][window] || FALLBACK;
    return costOf(setting.model, t.input, t.output);
  };

  if (options.dryRun) {
    console.log(`Matrix: ${MATRIX_SETTINGS.length} settings x ${names.length} windows x ${options.repeats} repeats = ${schedule.length} requests, one at a time, no retries. Nothing is sent.`);
    schedule.forEach(entry => console.log(`${String(entry.position + 1).padStart(3)}  repeat ${entry.repeat}  ${entry.window.padEnd(12)} rank ${entry.rank}  ${entry.setting.id}${entry.rank === 0 ? '   <- first on this window' : ''}`));
    const firsts = MATRIX_SETTINGS.map(s => `${s.id} ${schedule.filter(e => e.rank === 0 && e.setting === s).length}`);
    console.log(`\nSetting going first, over ${names.length * options.repeats} window runs: ${firsts.join(', ')}`);
    let total = 0;
    console.log('\nEstimate from the Phase 0 token counts of each setting and window (list prices in PRICES):');
    for (const s of MATRIX_SETTINGS) {
      const cost = names.reduce((sum, name) => sum + estimateOf(s, name), 0) * options.repeats;
      total += cost;
      const known = names.filter(name => tokens[s.id][name]).length;
      console.log(`  ${s.id.padEnd(20)} $${cost.toFixed(4)}  (${known}/${names.length} windows from Phase 0 tokens)`);
    }
    console.log(`  total                $${total.toFixed(4)}  against --max-cost ${options.maxCost}`);
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  const unitsBySetting = new Map(MATRIX_SETTINGS.map(s => [s.id, []]));
  const costBySetting = new Map(MATRIX_SETTINGS.map(s => [s.id, 0]));
  const started = stamp();
  let spent = 0;
  let stopped = false;
  let interrupted = false;
  const onSigint = () => { interrupted = true; console.log('\nInterrupt: finishing the request in flight, then writing what exists'); };
  process.once('SIGINT', onSigint);
  try {
    for (const entry of schedule) {
      const { setting } = entry;
      const expected = estimateOf(setting, entry.window);
      if (interrupted) { stopped = true; break; }
      if (spent + expected > options.maxCost) {
        stopped = true;
        console.log(`Stopping at request ${entry.position + 1}: $${spent.toFixed(4)} spent plus about $${expected.toFixed(4)} would pass --max-cost ${options.maxCost}`);
        break;
      }
      const tabs = all[entry.window];
      const t0 = performance.now();
      const result = await runPlan(tabs, setting);
      const wall = Math.round(performance.now() - t0);
      const input = result.requests.reduce((sum, r) => sum + (r.input_tokens || 0), 0);
      const output = result.requests.reduce((sum, r) => sum + (r.output_tokens || 0), 0);
      const thinkingTokens = result.requests.reduce((sum, r) => sum + (r.thinking_tokens || 0), 0);
      const cost = costOf(setting.model, input, output);
      spent += cost;
      costBySetting.set(setting.id, costBySetting.get(setting.id) + cost);
      const { text, ...request } = result.requests[0];
      const unit = makeUnit({
        window: entry.window, repeat: entry.repeat, tabs, answer: result.answer, failed: result.failed, wall_ms: wall,
        input_tokens: input, output_tokens: output, thinking_tokens: thinkingTokens, cost_usd: cost, request,
        extra: { schedule: { position: entry.position + 1, of: schedule.length, window_index: entry.windowIndex, rank: entry.rank, at: new Date().toISOString() } }
      });
      unitsBySetting.get(setting.id).push(unit);
      console.log(`${String(entry.position + 1).padStart(3)}/${schedule.length} ${entry.window.padEnd(12)} #${entry.repeat} ${setting.id.padEnd(20)} ${result.failed ? 'FAILED' : 'ok    '} F1 ${unit.score.f1.toFixed(2)} ${wall}ms out ${output}tok $${cost.toFixed(5)}  running $${spent.toFixed(4)}`);
      if (request.error) console.log(`    request error: HTTP ${request.status} ${request.error}`);
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    const files = [];
    for (const setting of MATRIX_SETTINGS) {
      const units = unitsBySetting.get(setting.id);
      if (!units.length) continue;
      const sent = units.find(unit => unit.requests[0])?.requests[0].sent || {};
      files.push(writeRun(options.out, `${settingFileId(setting)}_${started}.json`, {
        started, model: setting.model, mode: 'plan', thinking: setting.thinking, effort: setting.effort || null,
        thinking_sent: sent.thinking ?? null, effort_sent: sent.effort ?? null, thinking_note: sent.note || null,
        windows: names, repeats: options.repeats, api_version: '2026-10-21', matrix: true, matrix_requests: schedule.length,
        plan_example_name: units[0].plan_example_name, max_cost_usd: options.maxCost,
        cost_usd: costBySetting.get(setting.id), stopped_early: stopped, stability: stabilityOf(units, all), units
      }));
    }
    if (files.length) {
      writeSummary(options.out);
      files.forEach(file => console.log(`wrote ${path.relative(process.cwd(), file)}`));
    }
    console.log(`${stopped ? 'Stopped early. ' : ''}spent $${spent.toFixed(4)} of ${options.maxCost}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch(error => { console.error(String(error?.message || error)); process.exit(1); });
