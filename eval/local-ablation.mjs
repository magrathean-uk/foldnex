// Ablation of the similarity channels in the model-free grouping: what the
// lexical (title token) channel does alone, with URL words, and what the
// embedding table adds. Same protocol as run-local.mjs: clusters as groups and
// plan upkeep, settings chosen leave-one-window-out. Not product code.
//   node eval/local-ablation.mjs <models dir> [--out <dir>]
// Writes <out>/ablation.json and ablation.md (default eval/results). Seeded:
// two runs differ only in the timing block.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { titleTokens } from '../src/planner.js';
import { clusterAssignment, cut, dendrogram, tasksFromClusters } from './local-cluster.mjs';
import { REPS, attachCandidates, hiddenSet, upkeepScore } from './local-upkeep.mjs';
import { affinity, cosineMatrix, embed, loadModel, loadWindowRows, loadWindows, pairScore, sparseMatrix, syntheticWindow, toInt8, urlWords } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
const outDir = outIndex >= 0 ? argv.splice(outIndex, 2)[1] : path.join(HERE, 'results');
const MODELS_DIR = argv[0] || process.env.FOLDNEX_MODELS;
if (!MODELS_DIR) {
  console.error('Usage: node eval/local-ablation.mjs <dir holding potion-base-4M and -8M> [--out d]');
  process.exit(2);
}

// --- grids: those of run-local.mjs, widened for the lexical channels -----------------

const EMBEDS = [{ idf: false, center: false }, { idf: true, center: false }, { idf: false, center: true }, { idf: true, center: true }];
const WLS = [0, 0.5, 1];
const TAUS = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6];
const SHARES = [0.1, 0.2, 0.3, 0.5];
const UPKEEP_SEEDS = 20;
const THETAS = [-Infinity, 0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7];
// Lexical similarity is an overlap in [0, 1] and is 0 for most pairs, so the useful cuts sit far below the blend's.
const LEX_TAUS = [0.005, 0.01, 0.02, 0.03, 0.05, 0.075, 0.1, ...TAUS];
const LEX_THETAS = [-Infinity, 0, 0.005, 0.01, 0.02, 0.03, 0.05, 0.075, ...THETAS.slice(3)];
const NON_ENGLISH = new Set(['a-household', 'b-expat']);

const CHANNELS = [
  { id: 'lexical-title', lexical: 'title', taus: LEX_TAUS, thetas: LEX_THETAS },
  { id: 'lexical-title-url', lexical: 'title-url', taus: LEX_TAUS, thetas: LEX_THETAS },
  { id: 'dense-4M', model: 'potion-base-4M', wls: [0], taus: TAUS, thetas: THETAS },
  { id: 'dense-8M', model: 'potion-base-8M', wls: [0], taus: TAUS, thetas: THETAS },
  { id: 'blend-4M', model: 'potion-base-4M', wls: WLS, taus: TAUS, thetas: THETAS },
  { id: 'blend-8M', model: 'potion-base-8M', wls: WLS, taus: TAUS, thetas: THETAS }
];
// Optional per-channel overrides after an edge check, set below by EXTRA_TAUS / EXTRA_THETAS.
const EXTRA = JSON.parse(process.env.ABLATION_EXTRA || '{}');
for (const channel of CHANNELS) {
  if (EXTRA[channel.id]?.taus) channel.taus = EXTRA[channel.id].taus;
  if (EXTRA[channel.id]?.thetas) channel.thetas = EXTRA[channel.id].thetas.map(Number);
}

const meanOf = values => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
const round = value => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : value);

// --- lexical channels ----------------------------------------------------------------

/** sparseMatrix() over arbitrary token sets: idf-weighted overlap, identical arithmetic. */
function overlapMatrix(sets) {
  const n = sets.length;
  const df = new Map();
  for (const set of sets) for (const token of set) df.set(token, (df.get(token) || 0) + 1);
  const idf = token => Math.log((n + 1) / (df.get(token) + 0.5));
  const norms = sets.map(set => Math.sqrt([...set].reduce((sum, token) => sum + idf(token) ** 2, 0)) || 1);
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let dot = 0;
      for (const token of sets[i]) if (sets[j].has(token)) dot += idf(token) ** 2;
      out[i * n + j] = out[j * n + i] = dot / (norms[i] * norms[j]);
    }
  }
  return out;
}

export function lexicalMatrix(tabs, kind) {
  if (kind === 'title') return sparseMatrix(tabs);
  const sets = tabs.map(tab => {
    const set = new Set(titleTokens(tab));
    for (const word of urlWords(tab.url).split(' ')) if (word) set.add(word);
    return set;
  });
  return overlapMatrix(sets);
}

// --- per-window evaluation -------------------------------------------------------------

const windows = await loadWindows();
const names = Object.keys(windows).sort();
const models = {};
for (const channel of CHANNELS) {
  if (channel.model && !models[channel.model]) models[channel.model] = toInt8(loadModel(MODELS_DIR, channel.model));
}

/** Affinities of a channel on one window: [{id, S, V, wl, sparse}]. */
function affinities(channel, tabs) {
  if (channel.lexical) {
    const S = lexicalMatrix(tabs, channel.lexical);
    return [{ id: channel.lexical, S, V: tabs.map(() => new Float64Array(1)), wl: 0, sparse: S }];
  }
  const model = models[channel.model];
  const pairs = tabs.map(tab => [tab.title, urlWords(tab.url)]);
  const sparse = sparseMatrix(tabs);
  const list = [];
  for (const e of EMBEDS) {
    const V = embed(model, pairs, e);
    const dense = cosineMatrix(V);
    for (const wl of channel.wls) {
      list.push({ id: `${e.idf ? 'idf' : 'raw'}${e.center ? '-ctr' : ''}-wl${wl}`, S: wl ? dense.map((value, index) => value + wl * sparse[index]) : dense, V, wl, sparse });
    }
  }
  return list;
}

const results = {};
for (const channel of CHANNELS) {
  const reps = channel.lexical ? REPS.filter(rep => rep !== 'centroid') : REPS;
  const cluster = new Map(); // key -> {perWindow}
  const upkeep = new Map(); // key -> {perWindow: name -> f1 per share}
  for (const name of names) {
    const tabs = windows[name];
    const n = tabs.length;
    for (const a of affinities(channel, tabs)) {
      const tree = dendrogram(a.S, n);
      for (const tau of channel.taus) {
        const key = `${a.id}-t${tau}`;
        if (!cluster.has(key)) cluster.set(key, { key, perWindow: {} });
        cluster.get(key).perWindow[name] = pairScore(clusterAssignment(cut(tree, n, tau), tabs), tabs).f1;
      }
      const perShare = SHARES.map((share, si) => Array.from({ length: UPKEEP_SEEDS }, (_, seed) => {
        const hidden = hiddenSet(tabs, share, 1000 * (si + 1) + seed + 1);
        return { hidden, candidates: attachCandidates(tabs, hidden, a.S, a.V, a.sparse, a.wl) };
      }));
      for (const rep of reps) {
        for (const theta of channel.thetas) {
          const key = `${a.id}|${rep}|${theta}`;
          if (!upkeep.has(key)) upkeep.set(key, { key, perWindow: {} });
          upkeep.get(key).perWindow[name] = perShare.map(runs => meanOf(runs.map(run => upkeepScore(tabs, run.hidden, run.candidates, rep, theta).f1)));
        }
      }
    }
  }
  results[channel.id] = { channel, cluster: [...cluster.values()], upkeep: [...upkeep.values()] };
  console.log(`${channel.id}: ${cluster.size} cluster settings, ${upkeep.size} upkeep settings`);
}

// --- selection: leave one window out (first best wins ties, as in run-local) --------------

function select(configs, metric) {
  const score = (config, list) => meanOf(list.map(name => metric(config, name)));
  const best = list => configs.reduce((top, config) => (score(config, list) > score(top, list) ? config : top));
  const inSample = best(names);
  const heldOut = Object.fromEntries(names.map(name => {
    const chosen = best(names.filter(other => other !== name));
    return [name, { key: chosen.key, config: chosen }];
  }));
  return { inSample, heldOut };
}

const english = names.filter(name => !NON_ENGLISH.has(name));
const nonEnglish = names.filter(name => NON_ENGLISH.has(name));
const groupMeans = perWindow => ({
  all: meanOf(names.map(name => perWindow[name])),
  english: meanOf(english.map(name => perWindow[name])),
  nonEnglish: meanOf(nonEnglish.map(name => perWindow[name]))
});

const report = { channels: {} };
for (const { channel, cluster, upkeep } of Object.values(results)) {
  const c = select(cluster, (config, name) => config.perWindow[name]);
  const clusterHeld = Object.fromEntries(names.map(name => [name, c.heldOut[name].config.perWindow[name]]));
  const clusterIn = Object.fromEntries(names.map(name => [name, c.inSample.perWindow[name]]));

  const sharesOf = (config, list) => SHARES.map((share, si) => meanOf(list.map(name => config.perWindow[name][si])));
  const u = select(upkeep, (config, name) => meanOf(config.perWindow[name]));
  const upHeldPerWindow = Object.fromEntries(names.map(name => [name, u.heldOut[name].config.perWindow[name]]));
  const upHeld = SHARES.map((share, si) => ({ share, f1: meanOf(names.map(name => upHeldPerWindow[name][si])) }));
  const upHeldGroups = Object.fromEntries(SHARES.map((share, si) => [share, groupMeans(Object.fromEntries(names.map(name => [name, upHeldPerWindow[name][si]])))]));
  const upIn = sharesOf(u.inSample, names).map((f1, si) => ({ share: SHARES[si], f1 }));

  const tauOf = key => Number(key.slice(key.lastIndexOf('-t') + 2));
  const thetaOf = key => key.split('|')[2];
  const tauIn = tauOf(c.inSample.key);
  const thetaIn = thetaOf(u.inSample.key);
  const tauChosen = names.map(name => tauOf(c.heldOut[name].key));
  const thetaChosen = names.map(name => thetaOf(u.heldOut[name].key));
  const edge = (values, grid) => ({ lowest: Math.min(...values.map(Number)), highest: Math.max(...values.map(Number)), gridMin: Math.min(...grid.filter(Number.isFinite)), gridMax: Math.max(...grid.filter(Number.isFinite)) });
  report.channels[channel.id] = {
    grid: { tau: channel.taus, theta: channel.thetas.map(String), wl: channel.wls || null, switches: channel.lexical ? 'none (idf is built into the overlap)' : 'idf and centring, as run-local', reps: channel.lexical ? ['mean', 'max'] : REPS },
    cluster: {
      heldOut: { ...groupMeans(clusterHeld), perWindow: clusterHeld },
      inSample: { ...groupMeans(clusterIn), perWindow: clusterIn, setting: c.inSample.key },
      heldOutSettings: Object.fromEntries(names.map(name => [name, c.heldOut[name].key])),
      tauEdge: { inSample: tauIn, chosen: edge(tauChosen, channel.taus) }
    },
    upkeep: {
      heldOut: { shares: upHeld, groups: upHeldGroups, perWindow: Object.fromEntries(names.map(name => [name, Object.fromEntries(SHARES.map((share, si) => [share, upHeldPerWindow[name][si]]))])) },
      inSample: { shares: upIn, setting: u.inSample.key },
      heldOutSettings: Object.fromEntries(names.map(name => [name, u.heldOut[name].key])),
      thetaEdge: { inSample: thetaIn, chosen: edge(thetaChosen, channel.thetas) }
    }
  };
}

// --- control against local.json ------------------------------------------------------------

const local = JSON.parse(fs.readFileSync(path.join(outDir, 'local.json'), 'utf8'));
const control = {};
for (const size of ['4M', '8M']) {
  const mine = report.channels[`blend-${size}`];
  const recorded = local.selection[size].cluster;
  const up = local.upkeep[size].heldOut.shares;
  control[size] = {
    clusterHeldOut: { ablation: mine.cluster.heldOut.all, recorded: recorded.headline },
    upkeepHeldOut: SHARES.map((share, si) => ({ share, ablation: mine.upkeep.heldOut.shares[si].f1, recorded: up[si].f1 }))
  };
  control[size].maxDifference = Math.max(
    Math.abs(mine.cluster.heldOut.all - recorded.headline),
    ...control[size].upkeepHeldOut.map(row => Math.abs(row.ablation - row.recorded))
  );
  console.log(`control ${size}: max difference ${control[size].maxDifference.toFixed(4)}`);
}
report.control = control;

// --- timing: similarity and clustering only, warm, median of 20 ------------------------------

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const allRows = Object.values(await loadWindowRows()).flat();
const timing = {};
for (const channel of CHANNELS) {
  const best = report.channels[channel.id].cluster.inSample.setting;
  const tau = tauOfKey(best);
  const embedConfig = channel.lexical ? null : { idf: best.startsWith('idf'), center: best.includes('-ctr'), wl: Number(best.match(/wl([\d.]+)/)[1]), tau };
  const run = tabs => {
    const S = channel.lexical ? lexicalMatrix(tabs, channel.lexical) : affinity(models[channel.model], tabs, embedConfig);
    return cut(dendrogram(S, tabs.length), tabs.length, tau);
  };
  timing[channel.id] = { tau, sizes: {} };
  for (const n of [60, 200, 500]) {
    const tabs = syntheticWindow(allRows, n);
    for (let i = 0; i < 3; i++) run(tabs);
    const times = [];
    for (let i = 0; i < 20; i++) {
      const startedAt = performance.now();
      run(tabs);
      times.push(performance.now() - startedAt);
    }
    timing[channel.id].sizes[n] = median(times);
  }
}
function tauOfKey(key) {
  return Number(key.slice(key.lastIndexOf('-t') + 2));
}
report.timing = timing;

// --- write ---------------------------------------------------------------------------------

const rounded = value => JSON.parse(JSON.stringify(value, (key, v) => (typeof v === 'number' ? round(v) : v)));
const json = {
  protocol: {
    windows: names, english, nonEnglish: [...NON_ENGLISH], shares: SHARES, seeds: UPKEEP_SEEDS,
    note: 'Clusters as groups and plan upkeep, selection leave-one-window-out as run-local.mjs (first best wins ties). Blend grids are run-local\'s (all four idf/centring switches, wl 0, 0.5, 1); dense is the same grid at wl 0. Lexical channels have no switches and, in upkeep, only the mean and max representations (no dense centroid). Timing: warm, median of 20, similarity plus dendrogram and cut at the in-sample tau; not part of the determinism check.'
  },
  ...rounded(report)
};
fs.writeFileSync(path.join(outDir, 'ablation.json'), `${JSON.stringify(json, null, 2)}\n`);
console.log(`wrote ${path.join(outDir, 'ablation.json')}`);

const f = value => (Number.isFinite(value) ? value.toFixed(3) : 'n/a');
const ch = id => report.channels[id];
const lines = ['# Similarity channel ablation (model-free grouping)', ''];
lines.push('All F1 values are leave-one-window-out means (setting chosen on the other windows, scored on the window left out); in-sample best beside it. English = ten mostly English windows, non-English = a-household and b-expat.', '');
lines.push('## Clusters as groups', '', '| Channel | All 12 | English (10) | Non-English (2) | In-sample best | In-sample setting |', '| --- | ---: | ---: | ---: | ---: | --- |');
for (const channel of CHANNELS) {
  const c = ch(channel.id).cluster;
  lines.push(`| ${channel.id} | ${f(c.heldOut.all)} | ${f(c.heldOut.english)} | ${f(c.heldOut.nonEnglish)} | ${f(c.inSample.all)} | ${c.inSample.setting} |`);
}
lines.push('', '### Held-out F1 per window', '', `| Window | ${['lexical-title-url', 'dense-4M', 'blend-4M'].join(' | ')} |`, '| --- | ---: | ---: | ---: |');
for (const name of names) lines.push(`| ${name} | ${['lexical-title-url', 'dense-4M', 'blend-4M'].map(id => f(ch(id).cluster.heldOut.perWindow[name])).join(' | ')} |`);
lines.push('', '## Plan upkeep (held-out F1 at share of tabs hidden; mean over 12 windows)', '', '| Channel | 10% | 20% | 30% | 50% | 20% English | 20% non-English | In-sample 20% | In-sample setting |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
for (const channel of CHANNELS) {
  const u = ch(channel.id).upkeep;
  lines.push(`| ${channel.id} | ${u.heldOut.shares.map(row => f(row.f1)).join(' | ')} | ${f(u.heldOut.groups[0.2].english)} | ${f(u.heldOut.groups[0.2].nonEnglish)} | ${f(u.inSample.shares[1].f1)} | ${u.inSample.setting} |`);
}
lines.push('', '### Held-out upkeep F1 per window (20% new tabs)', '', `| Window | ${['lexical-title-url', 'dense-4M', 'blend-4M'].join(' | ')} |`, '| --- | ---: | ---: | ---: |');
for (const name of names) lines.push(`| ${name} | ${['lexical-title-url', 'dense-4M', 'blend-4M'].map(id => f(ch(id).upkeep.heldOut.perWindow[name][0.2])).join(' | ')} |`);
lines.push('', '## Timing (warm, median of 20, similarity plus clustering, ms)', '', '| Channel | 60 tabs | 200 tabs | 500 tabs |', '| --- | ---: | ---: | ---: |');
for (const channel of CHANNELS) lines.push(`| ${channel.id} | ${[60, 200, 500].map(n => timing[channel.id].sizes[n].toFixed(1)).join(' | ')} |`);
lines.push('', '## Control and grids', '');
for (const size of ['4M', '8M']) lines.push(`- blend-${size} against local.json: cluster ${f(control[size].clusterHeldOut.ablation)} vs ${f(control[size].clusterHeldOut.recorded)}; upkeep ${control[size].upkeepHeldOut.map(row => `${f(row.ablation)}/${f(row.recorded)}`).join(', ')}; max difference ${control[size].maxDifference.toFixed(4)}.`);
lines.push(`- tau grid: blend and dense as run-local (${TAUS[0]} to ${TAUS[TAUS.length - 1]}); lexical widened down to ${LEX_TAUS[0]}. Theta grid: lexical widened down to 0.005.`);
lines.push('- Lexical upkeep uses mean and max representations only (the dense centroid has no lexical form).');
const signed = value => `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;
const gaps = (metric) => names.map(name => ({ name, gap: metric('blend-4M', name) - metric('lexical-title', name) })).sort((a, b) => b.gap - a.gap);
const clusterMetric = (id, name) => ch(id).cluster.heldOut.perWindow[name];
const upkeepMetric = (id, name) => ch(id).upkeep.heldOut.perWindow[name][0.2];
const list = rows => rows.map(row => `${row.name} ${signed(row.gap)}`).join(', ');
const cg = gaps(clusterMetric);
const ug = gaps(upkeepMetric);
const cl = ch('lexical-title').cluster.heldOut;
const bl = ch('blend-4M').cluster.heldOut;
const ul = ch('lexical-title').upkeep.heldOut;
const ub = ch('blend-4M').upkeep.heldOut;
lines.push('', '## What the embedding table adds', '');
lines.push(`- Clusters: blend-4M ${f(bl.all)} against lexical-title ${f(cl.all)} (${signed(bl.all - cl.all)}; English ${signed(bl.english - cl.english)}, non-English ${signed(bl.nonEnglish - cl.nonEnglish)}); dense-4M alone ${f(ch('dense-4M').cluster.heldOut.all)} is no better than lexical alone, the gain comes from combining them.`);
lines.push(`- Clusters, by window (blend-4M minus lexical-title): largest ${list(cg.slice(0, 4))}; none or negative ${list(cg.filter(row => row.gap < 0.01))}.`);
lines.push(`- Upkeep at 20% new: blend-4M ${f(ub.shares[1].f1)} against lexical-title ${f(ul.shares[1].f1)} (${signed(ub.shares[1].f1 - ul.shares[1].f1)}); at 50% ${signed(ub.shares[3].f1 - ul.shares[3].f1)}. Lexical-title-url does not beat title alone in either task.`);
lines.push(`- Upkeep by window: largest ${list(ug.slice(0, 3))}; lexical ahead on ${list(ug.filter(row => row.gap < 0).reverse())}. On the two non-English windows lexical-title is ahead at 20% (${f(ul.groups[0.2].nonEnglish)} against ${f(ub.groups[0.2].nonEnglish)}).`);
lines.push(`- The 8M table is not better than 4M once blended (${f(bl.all)} against ${f(ch('blend-8M').cluster.heldOut.all)} for clusters, though it leads in upkeep); the 4 MB table's value is in clusters on English windows, much less in upkeep.`);
fs.writeFileSync(path.join(outDir, 'ablation.md'), `${lines.join('\n')}\n`);
