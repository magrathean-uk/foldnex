// Phase 2 upkeep measurement, step 2: score local attach on plans that never saw the new tabs. Not product code.
//   node eval/upkeep-unseen.mjs <recordings dir> [models dir holding potion-base-4M] [--out <dir>]
// Reads the units written by eval/run-upkeep-plans.mjs (real or --stub), applies each recorded plan to its visible
// tabs (scoring.mjs applyGroups), attaches the hidden tabs with each attach function over a grid of thresholds, and
// scores the whole window against gold. Writes report.md and report.json into the recordings directory.
// Deterministic; calls no model and no network.
//
// Attach functions:
//   product   : attachTabs of src/local-engine.js, imported dynamically (skipped with a note when file or export is missing)
//   prototype : eval/local-upkeep.mjs groupScorer, representation "mean" (a tab joins the group it is most similar to on
//               average when that similarity is at least theta)
// Channels:
//   title words : the planner's exact-word overlap only (no models directory needed)
//   vectors     : the 4M table, int8, idf on, centring off, title plus URL words at 0.5, one vector per tab across the
//                 window (needs the models directory). The prototype scores them as cosine + 1.0 x title-word overlap
//                 (the Phase 0 blend, wl 1); the product receives the vectors as a Map by tab id.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cosineMatrix, embed, loadModel, loadWindows, sparseMatrix, toInt8, urlWords } from './lib.mjs';
import { groupScorer } from './local-upkeep.mjs';
import { applyGroups, pairCounts, pairF1, planGroupsOf, prf } from './scoring.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PHASE1_DIR = path.join(HERE, 'results', 'provider', 'phase1');
const SHARES = [0.1, 0.2, 0.3, 0.5];
const GAP = 0.03; // attach this far below a fresh plan: a new plan is worth a request
const NONE = -Infinity;
const BASE_GRID = [NONE, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8];
const DEFAULT_THETA = 0.1; // Phase 0's held-out upkeep setting for ten of twelve windows (rescore.mjs); the product's own default is added when local-engine.js exports one
const WORDS_PRODUCT_NOTE = 'product attach not available yet';

const thetaLabel = theta => (theta === NONE ? 'none' : String(theta));
const meanOf = values => values.reduce((a, b) => a + b, 0) / (values.length || 1);
const round = value => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : value);
const deep = value => {
  if (Array.isArray(value)) return value.map(deep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deep(v)]));
  return round(value);
};
const f = (value, digits = 3) => (Number.isFinite(value) ? value.toFixed(digits) : '-');
const pct = value => (Number.isFinite(value) ? `${Math.round(value * 100)}%` : '-');

// --- arguments ------------------------------------------------------------------------------

const rawArgv = process.argv.slice(2);
const outAt = rawArgv.indexOf('--out');
const argv = outAt < 0 ? rawArgv : rawArgv.filter((_, index) => index !== outAt && index !== outAt + 1);
const DIR = argv[0] && path.resolve(argv[0]);
const MODELS_DIR = argv[1] && path.resolve(argv[1]);
// --out <dir>: write report.md and report.json there instead of into the recordings directory.
const OUT_DIR = outAt >= 0 && rawArgv[outAt + 1] ? path.resolve(rawArgv[outAt + 1]) : DIR;
if (!DIR || !fs.existsSync(DIR)) {
  console.error('Usage: node eval/upkeep-unseen.mjs <recordings dir> [models dir holding potion-base-4M]');
  process.exit(2);
}

// --- recordings -----------------------------------------------------------------------------

const windows = await loadWindows();
const files = fs.readdirSync(DIR).filter(name => name.endsWith('.json')).sort();
const runs = [];
for (const name of files) {
  let run;
  try { run = JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')); } catch { continue; }
  if (run?.mode === 'upkeep' && Array.isArray(run.units)) runs.push({ name, run });
}
if (!runs.length) {
  console.error(`No upkeep recordings in ${DIR} (expected files from eval/run-upkeep-plans.mjs)`);
  process.exit(2);
}
const stubbed = runs.some(({ run }) => run.stub);
const realToo = runs.some(({ run }) => !run.stub);
const units = runs.flatMap(({ run }) => run.units.map(unit => ({ ...unit, stub: Boolean(run.stub) })));
const failedUnits = units.filter(unit => unit.failed);
const usable = units.filter(unit => !unit.failed && windows[unit.window] && SHARES.includes(unit.share));
usable.sort((a, b) => a.window.localeCompare(b.window) || a.share - b.share);
const names = [...new Set(usable.map(unit => unit.window))].sort();

// --- fresh full-window plans (Phase 1 Sonnet, thinking off) ----------------------------------

const fresh = {};
{
  const file = fs.readdirSync(PHASE1_DIR).find(name => name.startsWith('claude-sonnet-5-5_plan_off_') && name.endsWith('.json'));
  const run = JSON.parse(fs.readFileSync(path.join(PHASE1_DIR, file), 'utf8'));
  const by = new Map();
  for (const unit of run.units) {
    if (unit.failed || !windows[unit.window]) continue;
    const tabs = windows[unit.window];
    const applied = applyGroups(planGroupsOf(unit.answer, tabs), tabs);
    if (!by.has(unit.window)) by.set(unit.window, []);
    by.get(unit.window).push({ all: pairF1(applied.assignment, tabs, 'all').f1, tasked: pairF1(applied.assignment, tabs, 'tasked').f1 });
  }
  for (const [name, list] of by) fresh[name] = { all: meanOf(list.map(x => x.all)), tasked: meanOf(list.map(x => x.tasked)), runs: list.length };
}

// --- attach functions -----------------------------------------------------------------------

let product = null;
let productNote = '';
let productDefault = null;
try {
  const module = await import(pathToFileURL(path.join(HERE, '..', 'src', 'local-engine.js')).href);
  if (typeof module.attachTabs !== 'function') throw new Error('src/local-engine.js has no attachTabs export');
  product = module.attachTabs;
  for (const [key, value] of Object.entries(module)) {
    if (/theta/i.test(key) && typeof value === 'number' && Number.isFinite(value)) productDefault = { key, value };
  }
  if (!productDefault && typeof module.ATTACH_THETA === 'number') productDefault = { key: 'ATTACH_THETA', value: module.ATTACH_THETA };
} catch (error) {
  const why = error?.code === 'ERR_MODULE_NOT_FOUND' && /local-engine/.test(String(error?.message)) ? 'src/local-engine.js is missing' : String(error?.message || error).split('\n')[0];
  productNote = `${WORDS_PRODUCT_NOTE}: ${why}. Prototype only.`;
}
console.log(product ? 'product attach: src/local-engine.js attachTabs' : productNote);

const model4M = MODELS_DIR ? toInt8(loadModel(MODELS_DIR, 'potion-base-4M')) : null;
if (!model4M) console.log('No models directory: title-word channels only.');

const GRID = [...new Set([...BASE_GRID, ...(productDefault ? [productDefault.value] : [])])].sort((a, b) => a - b);

const CHANNELS = [];
CHANNELS.push({ id: 'prototype/title', attach: 'prototype', channel: 'title words' });
if (model4M) CHANNELS.push({ id: 'prototype/vectors', attach: 'prototype', channel: 'vectors' });
if (product) {
  CHANNELS.push({ id: 'product/title', attach: 'product', channel: 'title words' });
  if (model4M) CHANNELS.push({ id: 'product/vectors', attach: 'product', channel: 'vectors' });
}

/** Per-window affinity and vectors (idf across the whole window, as Phase 0 did). */
const windowCache = new Map();
function windowData(name) {
  if (windowCache.has(name)) return windowCache.get(name);
  const tabs = windows[name];
  const n = tabs.length;
  const sparse = sparseMatrix(tabs);
  const data = { tabs, n, sparse, indexById: new Map(tabs.map((tab, i) => [tab.id, i])), byId: new Map(tabs.map(tab => [tab.id, tab])) };
  data.dummyV = Array.from({ length: n }, () => [0]);
  if (model4M) {
    data.V = embed(model4M, tabs.map(tab => [tab.title, urlWords(tab.url)]), { idf: true, center: false, urlWeight: 0.5 });
    const dense = cosineMatrix(data.V);
    data.blend = dense.map((value, index) => value + sparse[index]);
    data.vectors = new Map(tabs.map((tab, i) => [tab.id, Float32Array.from(data.V[i])]));
  }
  windowCache.set(name, data);
  return data;
}

/** Prototype: best group and its mean similarity for each hidden tab, once; thresholds are applied afterwards. */
function prototypeCandidates(data, channel, groups, hidden) {
  const members = groups.map((group, key) => ({ key, members: group.ids.map(id => data.indexById.get(id)) })).filter(group => group.members.length);
  const S = channel === 'vectors' ? data.blend : data.sparse;
  const V = channel === 'vectors' ? data.V : data.dummyV;
  const best = groupScorer(members, S, V, data.sparse, 0);
  return hidden.map(tab => ({ id: tab.id, ...(members.length ? best(data.indexById.get(tab.id), 'mean') : { group: null, score: NONE }) }));
}

/** Product attachTabs for one threshold: Map tab id -> group index. Tries tab objects, then ids, for the new tabs. */
function productPlaced(data, channel, groups, hidden, theta) {
  const stored = groups.map(group => ({ tabIds: group.ids.slice(), kind: 'model' }));
  const options = { vectors: channel === 'vectors' ? data.vectors : null, theta: theta === NONE ? -1 : theta }; // the product treats a non-finite theta as 'use the default', so the no-threshold control passes -1, below any similarity
  let result = product(stored, hidden, data.byId, options);
  const count = r => (r?.placed?.size ?? -1) + (r?.unplaced?.length ?? 0);
  if (count(result) !== hidden.length) result = product(stored, hidden.map(tab => tab.id), data.byId, options);
  if (count(result) !== hidden.length) throw new Error(`attachTabs returned ${count(result)} tabs for ${hidden.length} new tabs (tried tab objects and ids)`);
  return result.placed;
}

// --- scoring one unit -----------------------------------------------------------------------

function evaluate(data, applied, visible, hidden, placed) {
  const assignment = new Map(applied.assignment);
  for (const [id, group] of placed) assignment.set(id, group);
  const out = {};
  for (const population of ['all', 'tasked']) {
    const whole = pairCounts(assignment, data.tabs, population);
    const old = pairCounts(applied.assignment, visible, population);
    out[population] = prf(whole).f1;
    out[`new_${population}`] = prf({ tp: whole.tp - old.tp, predicted: whole.predicted - old.predicted, gold: whole.gold - old.gold }).f1;
  }
  const majority = applied.groups.map(group => {
    const counts = new Map();
    for (const id of group.ids) {
      const task = data.byId.get(id).task;
      if (task) counts.set(task, (counts.get(task) || 0) + 1);
    }
    let best = null; let top = 0;
    for (const [task, count] of counts) if (count > top) { best = task; top = count; }
    return best;
  });
  Object.assign(out, { right: 0, elsewhere: 0, out: 0, tasked_hidden: 0, loose_hidden: 0, loose_attached: 0 });
  for (const tab of hidden) {
    const group = placed.get(tab.id);
    if (tab.task) {
      out.tasked_hidden++;
      if (group === undefined) out.out++;
      else if (majority[group] === tab.task) out.right++;
      else out.elsewhere++;
    } else {
      out.loose_hidden++;
      if (group !== undefined) out.loose_attached++;
    }
  }
  return out;
}

const records = []; // {window, share, channel, theta, ...metrics}
const noAttach = []; // {window, share, ...metrics}
const visiblePlan = []; // {window, share, all, tasked}: the plan alone on the tabs it saw
const problems = [];
for (const unit of usable) {
  const data = windowData(unit.window);
  const visibleSet = new Set(unit.visible_ids);
  const visible = data.tabs.filter(tab => visibleSet.has(tab.id));
  const hidden = data.tabs.filter(tab => !visibleSet.has(tab.id));
  const applied = applyGroups(planGroupsOf(unit.answer, visible), visible);
  noAttach.push({ window: unit.window, share: unit.share, ...evaluate(data, applied, visible, hidden, new Map()) });
  visiblePlan.push({ window: unit.window, share: unit.share, all: pairF1(applied.assignment, visible, 'all').f1, tasked: pairF1(applied.assignment, visible, 'tasked').f1 });
  for (const channel of CHANNELS) {
    if (channel.attach === 'prototype') {
      const candidates = prototypeCandidates(data, channel.channel, applied.groups, hidden);
      for (const theta of GRID) {
        const placed = new Map(candidates.filter(c => c.group !== null && c.score >= theta).map(c => [c.id, c.group]));
        records.push({ window: unit.window, share: unit.share, channel: channel.id, theta, ...evaluate(data, applied, visible, hidden, placed) });
      }
    } else {
      for (const theta of GRID) {
        try {
          const placed = productPlaced(data, channel.channel, applied.groups, hidden, theta);
          records.push({ window: unit.window, share: unit.share, channel: channel.id, theta, ...evaluate(data, applied, visible, hidden, placed) });
        } catch (error) {
          problems.push(`${channel.id} ${unit.window} ${unit.share} theta ${thetaLabel(theta)}: ${String(error?.message || error).split('\n')[0]}`);
        }
      }
    }
  }
}
const droppedChannels = new Set();
for (const channel of CHANNELS) {
  const have = records.filter(r => r.channel === channel.id).length;
  if (have !== usable.length * GRID.length) droppedChannels.add(channel.id);
}

// --- aggregation ----------------------------------------------------------------------------

const METRICS = ['all', 'tasked', 'new_all', 'new_tasked'];
const COUNTS = ['right', 'elsewhere', 'out', 'tasked_hidden', 'loose_hidden', 'loose_attached'];

/** Window means (each window equal) of the F1 metrics and pooled outcome counts over the given records. */
function summarise(list) {
  const byWindow = new Map();
  for (const r of list) {
    if (!byWindow.has(r.window)) byWindow.set(r.window, []);
    byWindow.get(r.window).push(r);
  }
  const out = { windows: byWindow.size };
  for (const key of METRICS) out[key] = meanOf([...byWindow.values()].map(rs => meanOf(rs.map(r => r[key]))));
  for (const key of COUNTS) out[key] = list.reduce((sum, r) => sum + r[key], 0);
  out.right_share = out.right / (out.tasked_hidden || 1);
  out.elsewhere_share = out.elsewhere / (out.tasked_hidden || 1);
  out.out_share = out.out / (out.tasked_hidden || 1);
  out.loose_attached_share = out.loose_attached / (out.loose_hidden || 1);
  return out;
}

const forShare = share => (list => list.filter(r => r.share === share));
const reference = SHARES.map(share => {
  const rows = noAttach.filter(r => r.share === share);
  const winNames = [...new Set(rows.map(r => r.window))];
  return {
    share, windows: winNames.length,
    fresh_all: meanOf(winNames.map(name => fresh[name]?.all)), fresh_tasked: meanOf(winNames.map(name => fresh[name]?.tasked)),
    left_out: summarise(rows), visible_only: { all: meanOf(visiblePlan.filter(r => r.share === share).map(r => r.all)), tasked: meanOf(visiblePlan.filter(r => r.share === share).map(r => r.tasked)) }
  };
});

const tables = {};
for (const channel of CHANNELS) {
  if (droppedChannels.has(channel.id)) continue;
  tables[channel.id] = GRID.map(theta => ({
    theta: thetaLabel(theta),
    shares: SHARES.map(share => ({ share, ...summarise(records.filter(r => r.channel === channel.id && r.theta === theta && r.share === share)) }))
  }));
}

// --- decision -------------------------------------------------------------------------------

/** Whole-window all-tab F1 of each window at each theta, averaged over the four shares; windows with every share only. */
function objective(channelId) {
  const out = new Map();
  for (const name of names) {
    const perTheta = GRID.map(theta => {
      const rs = records.filter(r => r.channel === channelId && r.window === name && r.theta === theta);
      return SHARES.every(share => rs.some(r => r.share === share)) ? meanOf(SHARES.map(share => meanOf(rs.filter(r => r.share === share).map(r => r.all)))) : null;
    });
    if (perTheta.every(v => v !== null)) out.set(name, perTheta);
  }
  return out;
}

const decisions = {};
for (const channel of CHANNELS) {
  if (droppedChannels.has(channel.id)) continue;
  const objectives = objective(channel.id);
  const complete = [...objectives.keys()];
  const mean = (list, ti) => meanOf(list.map(name => objectives.get(name)[ti]));
  const inSample = GRID.map((theta, ti) => mean(complete, ti));
  const argmax = values => values.reduce((best, value, i) => (value > values[best] + 1e-12 ? i : best), 0);
  const chosen = {};
  const heldOut = complete.map(name => {
    const others = complete.filter(other => other !== name);
    const scores = GRID.map((theta, ti) => mean(others, ti));
    const ti = argmax(scores);
    chosen[ti] = (chosen[ti] || 0) + 1;
    return objectives.get(name)[ti];
  });
  const counts = GRID.map((theta, ti) => ({ theta: thetaLabel(theta), chosen: chosen[ti] || 0, in_sample: inSample[ti] }));
  const modal = counts.reduce((best, c, i) => (c.chosen > counts[best].chosen || (c.chosen === counts[best].chosen && c.in_sample > counts[best].in_sample) ? i : best), 0);
  const thetaModal = GRID[modal];
  const atModal = SHARES.map(share => {
    const rs = records.filter(r => r.channel === channel.id && r.theta === thetaModal && r.share === share);
    const s = summarise(rs);
    const freshAll = meanOf([...new Set(rs.map(r => r.window))].map(name => fresh[name]?.all));
    const left = reference.find(row => row.share === share).left_out.all;
    return { share, attach_all: s.all, fresh_all: freshAll, gap: freshAll - s.all, left_out_all: left, left_out_gap: freshAll - left, loose_attached_share: s.loose_attached_share, right_share: s.right_share, elsewhere_share: s.elsewhere_share, out_share: s.out_share };
  });
  const pooled = summarise(records.filter(r => r.channel === channel.id && r.theta === thetaModal));
  const pooledNone = summarise(records.filter(r => r.channel === channel.id && r.theta === NONE));
  const past = atModal.find(row => row.gap > GAP);
  decisions[channel.id] = {
    windows: complete.length,
    in_sample_best: { theta: thetaLabel(GRID[argmax(inSample)]), mean_all_f1: inSample[argmax(inSample)] },
    held_out_mean_all_f1: meanOf(heldOut),
    chosen: counts, modal_theta: thetaLabel(thetaModal),
    modal_in_sample: inSample[modal],
    no_threshold_mean_all_f1: inSample[0],
    loose_attached_share_at_modal: pooled.loose_attached_share,
    loose_attached_share_no_threshold: pooledNone.loose_attached_share,
    wrong_attach_of_tasked_at_modal: pooled.elsewhere_share,
    per_share: atModal,
    smallest_share_past_gap: past ? past.share : null,
    sentence: ''
  };
  const d = decisions[channel.id];
  d.sentence = `${channel.id}: threshold ${d.modal_theta} is chosen in ${chosen[modal] || 0} of ${complete.length} leave-one-window-out folds; held-out mean all-tab F1 over the four shares ${f(d.held_out_mean_all_f1)} (in-sample best ${d.in_sample_best.theta}, ${f(d.in_sample_best.mean_all_f1)}; no threshold ${f(d.no_threshold_mean_all_f1)}). At ${d.modal_theta}, ${pct(d.loose_attached_share_at_modal)} of loose hidden tabs are attached (each one wrong; ${pct(d.loose_attached_share_no_threshold)} with no threshold) and ${pct(d.wrong_attach_of_tasked_at_modal)} of hidden tabs with a gold task go to a group of another task. ${past ? `Attaching first scores more than ${GAP} below a fresh plan at ${pct(past.share)} new tabs (gap ${f(past.gap)}); from there a new plan is worth a request.` : `Attaching stays within ${GAP} of a fresh plan up to 50% new tabs (largest gap ${f(Math.max(...atModal.map(row => row.gap)))}).`}`;
}

// --- Phase 0 reference (recorded plans that had seen the tabs) --------------------------------

let phase0 = null;
try {
  const rescore = JSON.parse(fs.readFileSync(path.join(HERE, 'results', 'rescore.json'), 'utf8'));
  const row = rescore.upkeep.plans.find(plan => plan.id === 'claude-sonnet-5-5|plan|adaptive-low');
  phase0 = { label: row.label, fresh_all: row.fresh.all, shares: row.shares.map(s => ({ share: s.share, all: s.all, tasked: s.tasked, no_attach_all: s.noAttachAll, loose_attached_share: s.looseAttachedShare })) };
} catch { /* the reference is optional */ }

// --- output ---------------------------------------------------------------------------------

const result = deep({
  source: { files: runs.map(r => r.name), stub: stubbed, real_and_stub_mixed: stubbed && realToo, units: units.length, failed_units: failedUnits.length, scored_units: usable.length, windows: names },
  attach: { product: product ? { available: true, default_theta: productDefault } : { available: false, note: productNote }, models_dir: Boolean(MODELS_DIR), channels: CHANNELS.map(c => c.id), skipped: [...droppedChannels], problems },
  grid: GRID.map(thetaLabel), shares: SHARES, gap: GAP,
  fresh_reference: 'results/provider/phase1 Sonnet 5.5 thinking off, both repeats, applied, same window',
  reference, tables, decisions, phase0
});
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
fs.writeFileSync(path.join(OUT_DIR, 'report.md'), markdown(result));
console.log(`wrote ${path.relative(process.cwd(), path.join(OUT_DIR, 'report.json'))} and report.md`);

function markdown(r) {
  const lines = [];
  lines.push('# Phase 2 upkeep: attach on plans that never saw the new tabs', '');
  lines.push(`Generated by \`node eval/upkeep-unseen.mjs\` from ${r.source.files.map(n => `\`${n}\``).join(', ')}. No model was called. Scoring policy: \`eval/scoring.mjs\` (applied result, ten groups, tabs left out are singletons).`, '');
  if (r.source.stub) lines.push(`**These are stub recordings${r.source.real_and_stub_mixed ? ' (mixed with real ones: do not read the figures)' : ''}**: the Phase 1 plans, which had seen the hidden tabs, with the hidden tabs removed. They check the pipeline and reproduce the optimistic Phase 0 protocol; they are not the Phase 2 measurement.`, '');
  lines.push(`Units: ${r.source.scored_units} scored of ${r.source.units} (${r.source.failed_units} failed requests skipped), ${r.source.windows.length} windows, one hidden set per window and share (first Phase 0 seed of each share).`);
  lines.push(r.attach.product.available
    ? `Product attach: \`attachTabs\` of \`src/local-engine.js\`${r.attach.product.default_theta ? ` (exported default ${r.attach.product.default_theta.key} = ${r.attach.product.default_theta.value}, added to the grid)` : ''}.`
    : `**${r.attach.product.note}**`);
  lines.push(`Channels: ${r.attach.channels.join(', ')}.${r.attach.models_dir ? '' : ' No models directory given: title words only.'} Vectors: 4M int8, idf on, centring off, title plus URL words at 0.5, built over the whole window; the prototype scores them as cosine plus title-word overlap (wl 1).`);
  if (r.attach.skipped.length) lines.push(`Skipped (the function failed on some unit): ${r.attach.skipped.join(', ')}.`);
  for (const p of r.attach.problems.slice(0, 5)) lines.push(`- problem: ${p}`);
  lines.push(`Threshold grid: ${r.grid.join(', ')} ("none" attaches every hidden tab to its best group; 0.1 is Phase 0's held-out setting). Means are over windows, each window equal; outcome shares are pooled over tabs.`, '');

  lines.push('## Reference', '');
  lines.push('| Hidden | Fresh plan (Phase 1), all / tasked | Plan on the tabs it saw, all / tasked | Hidden tabs left out, all / tasked | Left out, new-tab pairs tasked |', '| ---: | --- | --- | --- | ---: |');
  for (const row of r.reference) lines.push(`| ${pct(row.share)} | ${f(row.fresh_all)} / ${f(row.fresh_tasked)} | ${f(row.visible_only.all)} / ${f(row.visible_only.tasked)} | ${f(row.left_out.all)} / ${f(row.left_out.tasked)} | ${f(row.left_out.new_tasked)} |`);
  if (r.phase0) {
    lines.push('', `Phase 0, recorded plans that had seen the tabs (${r.phase0.label}, 20 seeds, held-out settings, optimistic), all tabs: fresh ${f(r.phase0.fresh_all)}; ${r.phase0.shares.map(s => `${pct(s.share)} attached ${f(s.all)}, left out ${f(s.no_attach_all)}, loose attached ${pct(s.loose_attached_share)}`).join('; ')}.`);
  }

  for (const [id, rows] of Object.entries(r.tables)) {
    lines.push('', `## ${id}`, '');
    lines.push('Whole window with the hidden tabs attached, all-tab / tasked F1:', '');
    lines.push(`| Threshold | ${r.shares.map(pct).join(' | ')} |`, `| --- | ${r.shares.map(() => '---:').join(' | ')} |`);
    for (const row of rows) lines.push(`| ${row.theta} | ${row.shares.map(s => `${f(s.all, 2)} / ${f(s.tasked, 2)}`).join(' | ')} |`);
    lines.push('', 'F1 over only the pairs that touch a new tab, tasked / all-tab:', '');
    lines.push(`| Threshold | ${r.shares.map(pct).join(' | ')} |`, `| --- | ${r.shares.map(() => '---:').join(' | ')} |`);
    for (const row of rows) lines.push(`| ${row.theta} | ${row.shares.map(s => `${f(s.new_tasked, 2)} / ${f(s.new_all, 2)}`).join(' | ')} |`);
    lines.push('', 'Hidden tabs with a gold task: attached to a group of their task / attached elsewhere / left out; then loose hidden tabs attached (each one wrong):', '');
    lines.push(`| Threshold | ${r.shares.map(pct).join(' | ')} |`, `| --- | ${r.shares.map(() => '---').join(' | ')} |`);
    for (const row of rows) lines.push(`| ${row.theta} | ${row.shares.map(s => `${pct(s.right_share)} / ${pct(s.elsewhere_share)} / ${pct(s.out_share)}; loose ${pct(s.loose_attached_share)}`).join(' | ')} |`);
  }

  lines.push('', '## Decision', '');
  lines.push(`Threshold chosen by the mean all-tab F1 over the four shares, leave-one-window-out (each window scored with the threshold that is best on the other windows). "Smallest share past the gap" is the first share at which attaching at the most-chosen threshold scores more than ${GAP} below the fresh plan (all-tab F1, same windows).`, '');
  for (const [id, d] of Object.entries(r.decisions)) {
    lines.push(`- ${d.sentence}`);
  }
  lines.push('', '| Channel | Most-chosen threshold | Folds | Held-out F1 | Loose attached | Smallest share past the gap |', '| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const [id, d] of Object.entries(r.decisions)) {
    lines.push(`| ${id} | ${d.modal_theta} | ${d.chosen.find(c => c.theta === d.modal_theta).chosen} of ${d.windows} | ${f(d.held_out_mean_all_f1)} | ${pct(d.loose_attached_share_at_modal)} | ${d.smallest_share_past_gap === null ? 'none up to 50%' : pct(d.smallest_share_past_gap)} |`);
  }
  for (const [id, d] of Object.entries(r.decisions)) {
    lines.push('', `Threshold choices, ${id}: ${d.chosen.filter(c => c.chosen).map(c => `${c.theta} x${c.chosen}`).join(', ')}.`, '');
    lines.push('| Hidden | Fresh plan | Attached at ' + d.modal_theta + ' | Gap | Left out | Gap, left out | Loose attached | Task tabs right / elsewhere / out |', '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const s of d.per_share) lines.push(`| ${pct(s.share)} | ${f(s.fresh_all)} | ${f(s.attach_all)} | ${f(s.gap)} | ${f(s.left_out_all)} | ${f(s.left_out_gap)} | ${pct(s.loose_attached_share)} | ${pct(s.right_share)} / ${pct(s.elsewhere_share)} / ${pct(s.out_share)} |`);
  }
  lines.push('');
  return lines.join('\n');
}
