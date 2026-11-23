// Phase 2 upkeep measurement, step 1: plans that never saw the new tabs. Not product code.
//
// For every window and each share of 10, 20, 30 and 50% of the tabs, a seeded set of tabs is hidden
// (eval/local-upkeep.mjs hiddenSet, the first seed of each share in eval/rescore.mjs: 1000 * (share index + 1) + 1,
// so the hidden sets are the ones Phase 0 used) and ONE plan request is sent for the visible tabs only:
// Claude Sonnet 5.5, thinking off, the product's prompt and schema (src/ai-engine.js), no retries.
// 12 windows x 4 shares = 48 requests, one at a time, shares rotated within a window so no share always goes first.
// eval/upkeep-unseen.mjs then attaches the hidden tabs locally and scores the whole window.
//
//   node eval/run-upkeep-plans.mjs --dry-run                 schedule and cost estimate, sends nothing
//   export ANTHROPIC_API_KEY=...                             the key is read from here only, never printed or stored
//   node eval/run-upkeep-plans.mjs [--max-cost 1]            spends money; writes results/provider/phase2-upkeep/
//   node eval/run-upkeep-plans.mjs --stub --out <dir>        no network: answers from the recorded Phase 1 Sonnet plan
//                                                            (repeat 0) of the same window, hidden tabs removed
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWindows } from './lib.mjs';
import { hiddenSet } from './local-upkeep.mjs';
import { PRICES } from './run-provider.mjs';
import { makeUnit, meanOf, planOutputBudget, planRequest, stamp } from './phase1-lib.mjs';
import { requestMessage } from './provider-claude.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT = path.join(HERE, 'results', 'provider', 'phase2-upkeep');
const PHASE1_DIR = path.join(HERE, 'results', 'provider', 'phase1');

export const MODEL = 'claude-sonnet-5-5';
export const SHARES = [0.1, 0.2, 0.3, 0.5];
/** The first hidden set of each share in rescore.mjs: seed 1000 * (share index + 1) + 0 + 1. */
export const seedFor = shareIndex => 1000 * (shareIndex + 1) + 1;
const API_VERSION = '2026-10-21';

/** The hidden and visible sides of one window at one share: {hidden: [tab], visible: [tab]} (visible in strip order). */
export function splitWindow(tabs, shareIndex) {
  const hiddenIdx = hiddenSet(tabs, SHARES[shareIndex], seedFor(shareIndex));
  return { hidden: tabs.filter((tab, i) => hiddenIdx.has(i)), visible: tabs.filter((tab, i) => !hiddenIdx.has(i)) };
}

/** One entry per request; the share that goes first rotates with the window index. */
export function upkeepSchedule(windowNames) {
  const schedule = [];
  windowNames.forEach((window, windowIndex) => {
    for (let rank = 0; rank < SHARES.length; rank++) {
      const shareIndex = (windowIndex + rank) % SHARES.length;
      schedule.push({ position: schedule.length, window, windowIndex, rank, shareIndex, share: SHARES[shareIndex], seed: seedFor(shareIndex) });
    }
  });
  return schedule;
}

function parseArgs(argv) {
  const options = { windows: 'all', maxCost: 1, out: null, dryRun: false, stub: false };
  const names = { '--windows': 'windows', '--max-cost': 'maxCost', '--out': 'out' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') options.dryRun = true;
    else if (argv[i] === '--stub') options.stub = true;
    else if (names[argv[i]]) options[names[argv[i]]] = argv[++i];
    else throw new Error(`Unknown option ${argv[i]}`);
  }
  options.maxCost = Number(options.maxCost);
  if (!Number.isFinite(options.maxCost) || options.maxCost <= 0) throw new Error('--max-cost must be a positive number');
  options.out = path.resolve(options.out || DEFAULT_OUT);
  return options;
}

const costOf = (input, output) => {
  const [pi, po] = PRICES[MODEL];
  return ((input || 0) * pi + (output || 0) * po) / 1e6;
};

/** Phase 1 Sonnet (thinking off) recordings: {window: {input, output, answer}} (tokens: mean of the repeats; answer: repeat 0). */
function phase1Sonnet() {
  const out = {};
  const file = fs.readdirSync(PHASE1_DIR).find(name => name.startsWith(`${MODEL}_plan_off_`) && name.endsWith('.json'));
  if (!file) throw new Error(`No Phase 1 ${MODEL} thinking-off recording in ${PHASE1_DIR}`);
  const run = JSON.parse(fs.readFileSync(path.join(PHASE1_DIR, file), 'utf8'));
  const byWindow = new Map();
  for (const unit of run.units) {
    if (unit.failed) continue;
    if (!byWindow.has(unit.window)) byWindow.set(unit.window, []);
    byWindow.get(unit.window).push(unit);
  }
  for (const [name, units] of byWindow) {
    units.sort((a, b) => a.repeat - b.repeat);
    out[name] = { input: meanOf(units.map(u => u.input_tokens)), output: meanOf(units.map(u => u.output_tokens)), answer: units[0].answer };
  }
  return out;
}

const promptChars = tabs => { const r = planRequest(tabs); return r.system.length + r.user.length + JSON.stringify(r.schema).length; };

/** Estimated tokens of a visible-only request: Phase 1 input scaled by the character length of the real prompts, output by the visible share. */
function estimateTokens(reference, tabs, visible) {
  return { input: reference.input * (promptChars(visible) / promptChars(tabs)), output: reference.output * (visible.length / tabs.length) };
}

/** The recorded full-window answer with the hidden tabs removed, ordinals renumbered to the visible order. */
function stubAnswer(answer, tabs, visible) {
  const visibleOrdinal = new Map(visible.map((tab, i) => [tab.id, i]));
  return {
    folders: (answer.folders || []).map(folder => ({
      name: folder.name,
      ids: (folder.ids || []).map(ordinal => tabs[ordinal] && visibleOrdinal.get(tabs[ordinal].id)).filter(i => i !== undefined)
    })).filter(folder => folder.ids.length)
  };
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const all = await loadWindows();
  const names = options.windows === 'all' ? Object.keys(all) : options.windows.split(',').map(name => name.trim());
  for (const name of names) if (!all[name]) throw new Error(`Unknown window "${name}". Have: ${Object.keys(all).join(', ')}`);
  const schedule = upkeepSchedule(names);
  const reference = phase1Sonnet();
  const FALLBACK = { input: 4000, output: 300 };
  const split = new Map();
  const splitOf = entry => {
    const key = `${entry.window}|${entry.shareIndex}`;
    if (!split.has(key)) split.set(key, splitWindow(all[entry.window], entry.shareIndex));
    return split.get(key);
  };
  const estimateOf = entry => {
    const tokens = estimateTokens(reference[entry.window] || FALLBACK, all[entry.window], splitOf(entry).visible);
    return { ...tokens, cost: costOf(tokens.input, tokens.output) };
  };

  if (options.dryRun) {
    console.log(`Upkeep plans: ${names.length} windows x ${SHARES.length} shares = ${schedule.length} requests, one at a time, no retries. ${MODEL}, thinking off. Nothing is sent.`);
    for (const entry of schedule) {
      const { hidden, visible } = splitOf(entry);
      const e = estimateOf(entry);
      console.log(`${String(entry.position + 1).padStart(3)}  ${entry.window.padEnd(12)} hide ${String(Math.round(entry.share * 100)).padStart(2)}%  seed ${entry.seed}  hidden ${String(hidden.length).padStart(3)}  visible ${String(visible.length).padStart(3)}  est ${Math.round(e.input)} in / ${Math.round(e.output)} out  $${e.cost.toFixed(4)}`);
    }
    const total = schedule.reduce((sum, entry) => sum + estimateOf(entry).cost, 0);
    const known = names.filter(name => reference[name]).length;
    console.log(`\nEstimate: $${total.toFixed(4)} for ${schedule.length} requests (Phase 1 Sonnet thinking-off tokens of ${known}/${names.length} windows; input scaled by the character length of the visible-only prompt, output by the visible share; list prices in run-provider.mjs PRICES), against --max-cost ${options.maxCost}.`);
    return;
  }
  if (!options.stub && !process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set (use --dry-run or --stub to run without a key)');

  const units = [];
  const started = options.stub ? 'stub' : stamp();
  let spent = 0;
  let stopped = false;
  let interrupted = false;
  const onSigint = () => { interrupted = true; console.log('\nInterrupt: finishing the request in flight, then writing what exists'); };
  process.once('SIGINT', onSigint);
  try {
    for (const entry of schedule) {
      if (interrupted) { stopped = true; break; }
      const expected = estimateOf(entry);
      if (!options.stub && spent + expected.cost > options.maxCost) {
        stopped = true;
        console.log(`Stopping at request ${entry.position + 1}: $${spent.toFixed(4)} spent plus about $${expected.cost.toFixed(4)} would pass --max-cost ${options.maxCost}`);
        break;
      }
      const tabs = all[entry.window];
      const { hidden, visible } = splitOf(entry);
      let unit;
      if (options.stub) {
        const answer = stubAnswer(reference[entry.window].answer, tabs, visible);
        const request = { ok: true, status: 0, error: null, wall_ms: 0, stub: true };
        unit = makeUnit({ window: entry.window, repeat: 0, tabs: visible, answer, failed: false, wall_ms: 0, input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cost_usd: 0, request });
      } else {
        const { system, user, schema } = planRequest(visible);
        const t0 = performance.now();
        const request = await requestMessage({ model: MODEL, system, user, schema, maxTokens: planOutputBudget(visible.length), thinking: 'off', effort: '' });
        const wall = Math.round(performance.now() - t0);
        const answer = request.ok ? parseJson(request.text) : null;
        const cost = costOf(request.input_tokens, request.output_tokens);
        spent += cost;
        const { text, ...rest } = request;
        unit = makeUnit({
          window: entry.window, repeat: 0, tabs: visible, answer, failed: !request.ok || !answer, wall_ms: wall,
          input_tokens: request.input_tokens || 0, output_tokens: request.output_tokens || 0, thinking_tokens: request.thinking_tokens || 0, cost_usd: cost, request: rest
        });
      }
      Object.assign(unit, {
        share: entry.share, seed: entry.seed, window_tabs: tabs.length, visible_tabs: visible.length,
        hidden_ids: hidden.map(tab => tab.id), visible_ids: visible.map(tab => tab.id),
        schedule: { position: entry.position + 1, of: schedule.length, rank: entry.rank, ...(options.stub ? {} : { at: new Date().toISOString() }) }
      });
      units.push(unit);
      console.log(`${String(entry.position + 1).padStart(3)}/${schedule.length} ${entry.window.padEnd(12)} hide ${String(Math.round(entry.share * 100)).padStart(2)}%  ${unit.failed ? 'FAILED' : 'ok    '} F1(visible) ${unit.score.f1.toFixed(2)} ${unit.wall_ms}ms out ${unit.output_tokens}tok $${unit.cost_usd.toFixed(5)}  running $${spent.toFixed(4)}`);
      if (unit.requests[0].error) console.log(`    request error: HTTP ${unit.requests[0].status} ${unit.requests[0].error}`);
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    if (units.length) {
      fs.mkdirSync(options.out, { recursive: true });
      const file = path.join(options.out, options.stub ? 'upkeep-stub.json' : `${MODEL}_upkeep_off_${started}.json`);
      const sent = units.find(unit => unit.requests[0]?.sent)?.requests[0].sent || {};
      fs.writeFileSync(file, JSON.stringify({
        started, mode: 'upkeep', stub: options.stub,
        ...(options.stub ? { stub_note: 'Not a model answer: the recorded Phase 1 Sonnet (thinking off, repeat 0) plan of the window with the hidden tabs removed. That plan had seen the hidden tabs.' } : {}),
        model: MODEL, thinking: 'off', thinking_sent: sent.thinking ?? null, api_version: API_VERSION,
        shares: SHARES, seeds: SHARES.map((s, i) => seedFor(i)), seed_rule: '1000 * (share index + 1) + 1, the first seed of each share in eval/rescore.mjs',
        windows: names, requests_scheduled: schedule.length, max_cost_usd: options.maxCost, cost_usd: spent, stopped_early: stopped,
        plan_example_name: units[0].plan_example_name,
        units: units.map(({ _assignment, ...unit }) => unit)
      }, null, 1));
      console.log(`wrote ${path.relative(process.cwd(), file)}`);
    }
    console.log(`${stopped ? 'Stopped early. ' : ''}${units.length} of ${schedule.length} requests${options.stub ? ' (stub)' : `, spent $${spent.toFixed(4)} of ${options.maxCost}`}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch(error => { console.error(String(error?.message || error)); process.exit(1); });
