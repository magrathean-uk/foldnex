// Measures two refinements of the local grouping engine and its behaviour on small
// windows. Evidence for docs/development/grouping-fix-plan.md; not product code.
//   node eval/local-variants.mjs <models dir holding potion-base-4M>
// Writes eval/results/local-variants.md and .json (deterministic).
//
// Variant A: tabs the baseline leaves unassigned go through the old rule cascade
//   (inferredLabels + planGroups, run on those tabs alone); its groups of two or more
//   tabs are added largest first while the total stays within ten groups counting
//   Review Later.
// Variant B: a cluster holding more than half of the window's tabs is cut again at
//   tau + delta on its own tabs (delta 0.05, 0.1, 0.2); then the ten-largest rule.
// The engine does not export its similarity matrix or linkage, so B carries a copy of
// both; the copy is asserted to reproduce clusterTabs exactly (selfCheck).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clusterTabs, LOCAL_SETTINGS } from '../src/local-engine.js';
import { MAX_GROUPS } from '../src/ai-engine.js';
import { REVIEW_GROUP_NAME } from '../src/label-vocabulary.js';
import { titleTokenDetails } from '../src/planner.js';
import { planGroups } from './legacy-labels.mjs';
import { inferredLabels } from './lib-legacy.mjs';
import { embed, loadModel, loadWindows, mulberry32, seedFor, toInt8, urlWords } from './lib.mjs';
import { applyGroups, pairF1 } from './scoring.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = process.argv[2];
if (!MODELS_DIR) {
  console.error('usage: node eval/local-variants.mjs <models dir>');
  process.exit(1);
}
const DELTAS = [0.05, 0.1, 0.2];
const SIZES = [8, 15, 25];
const SUBSETS = 20;
const round = value => Math.round(value * 1e4) / 1e4;
const meanOf = values => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);

const windows = await loadWindows();
const names = Object.keys(windows).sort();
const model = toInt8(loadModel(MODELS_DIR, 'potion-base-4M'));

function vectorsFor(tabs) {
  const rows = embed(model, tabs.map(tab => [tab.title, urlWords(tab.url)]), { idf: true, center: false, urlWeight: 0.5 });
  return new Map(tabs.map((tab, index) => [tab.id, Float32Array.from(rows[index])]));
}

// ---- copy of the engine's similarity and average linkage (src/local-engine.js) ----
function idfOver(sets) {
  const df = new Map();
  for (const set of sets) for (const token of set) df.set(token, (df.get(token) || 0) + 1);
  const idf = new Map();
  for (const [token, count] of df) idf.set(token, Math.log((sets.length + 1) / (count + 0.5)));
  return idf;
}
const normOf = (set, idf) => Math.sqrt([...set].reduce((sum, token) => sum + (idf.get(token) || 0) ** 2, 0)) || 1;

function similarityMatrix(tabs, vectors) {
  const n = tabs.length;
  const sets = tabs.map(tab => titleTokenDetails(tab).tokens);
  const idf = idfOver(sets);
  const norms = sets.map(set => normOf(set, idf));
  const postings = new Map();
  sets.forEach((set, index) => {
    for (const token of set) {
      if (!postings.has(token)) postings.set(token, []);
      postings.get(token).push(index);
    }
  });
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (const token of sets[i]) {
      const weight = idf.get(token) ** 2;
      for (const j of postings.get(token)) if (j > i) out[i * n + j] += weight;
    }
    for (let j = i + 1; j < n; j++) {
      const value = out[i * n + j] / (norms[i] * norms[j]);
      out[i * n + j] = value;
      out[j * n + i] = value;
    }
  }
  if (!vectors) return out;
  const weight = LOCAL_SETTINGS.vectors.wordWeight;
  const rows = tabs.map(tab => vectors.get(tab.id) || null);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let cosine = 0;
      const a = rows[i];
      const b = rows[j];
      if (a && b) for (let d = 0; d < a.length; d++) cosine += a[d] * b[d];
      const value = cosine + weight * out[i * n + j];
      out[i * n + j] = value;
      out[j * n + i] = value;
    }
  }
  return out;
}

function averageLinkage(S, n, tau) {
  const sim = Float64Array.from(S);
  const active = new Uint8Array(n).fill(1);
  const size = new Float64Array(n).fill(1);
  const best = new Float64Array(n);
  const bestJ = new Int32Array(n);
  const parent = Int32Array.from({ length: n }, (_, index) => index);
  const rescan = i => {
    best[i] = -Infinity;
    bestJ[i] = -1;
    for (let j = 0; j < n; j++) {
      if (j === i || !active[j]) continue;
      if (sim[i * n + j] > best[i]) {
        best[i] = sim[i * n + j];
        bestJ[i] = j;
      }
    }
  };
  for (let i = 0; i < n; i++) rescan(i);
  for (let step = 0; step < n - 1; step++) {
    let i = -1;
    for (let k = 0; k < n; k++) if (active[k] && bestJ[k] >= 0 && (i < 0 || best[k] > best[i])) i = k;
    if (i < 0 || best[i] < tau) break;
    const j = bestJ[i];
    const a = Math.min(i, j);
    const b = Math.max(i, j);
    parent[b] = a;
    const total = size[a] + size[b];
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === a || k === b) continue;
      const value = (size[a] * sim[a * n + k] + size[b] * sim[b * n + k]) / total;
      sim[a * n + k] = value;
      sim[k * n + a] = value;
    }
    size[a] = total;
    active[b] = 0;
    rescan(a);
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === a) continue;
      if (bestJ[k] === a || bestJ[k] === b) rescan(k);
      else if (sim[k * n + a] > best[k] || (sim[k * n + a] === best[k] && a < bestJ[k])) {
        best[k] = sim[k * n + a];
        bestJ[k] = a;
      }
    }
  }
  const find = x => {
    while (parent[x] !== x) x = parent[x];
    return x;
  };
  const byRoot = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(i);
  }
  return [...byRoot.values()];
}

// ---- plan construction ----------------------------------------------------------
/** Clusters (arrays of tab indices) of a tab list at tau + delta. */
function clustersOf(tabs, vectors, delta) {
  const useVectors = vectors instanceof Map && vectors.size > 0;
  const tau = (useVectors ? LOCAL_SETTINGS.vectors.tau : LOCAL_SETTINGS.words.tau) + delta;
  if (tabs.length < 2) return tabs.map((_, index) => [index]);
  return averageLinkage(similarityMatrix(tabs, useVectors ? vectors : null), tabs.length, tau);
}

/** The ten-largest rule of the engine: clusters of 2+ kept, largest first, Review Later counted. */
function capClusters(clusters, n, limit = MAX_GROUPS) {
  const kept = clusters.filter(cluster => cluster.length >= 2).map((tabIds, order) => ({ tabIds, order }));
  const anyUnassigned = kept.reduce((sum, item) => sum + item.tabIds.length, 0) < n;
  const room = anyUnassigned || kept.length > limit ? limit - 1 : limit;
  const survivors = new Set([...kept].sort((x, y) => y.tabIds.length - x.tabIds.length || x.order - y.order).slice(0, room));
  return kept.filter(item => survivors.has(item)).map(item => item.tabIds);
}

/** Variant B on top of the baseline clusters; groups of tab ids. */
function clusterGroups(tabs, vectors, delta) {
  const n = tabs.length;
  let clusters = clustersOf(tabs, vectors, 0);
  if (delta > 0) {
    clusters = clusters.flatMap(cluster => {
      if (cluster.length * 2 <= n) return [cluster];
      const own = cluster.map(index => tabs[index]);
      return clustersOf(own, vectors, delta).map(part => part.map(position => cluster[position]));
    });
  }
  return capClusters(clusters, n).map(cluster => cluster.map(index => tabs[index].id));
}

/** The old rule cascade alone: applied groups, Review Later unassigned. */
function rulesApplied(tabs) {
  const plan = planGroups(tabs, inferredLabels(tabs), { locked: [] });
  return applyGroups(plan.groups.map(group => ({ name: group.name, ids: group.tabIds })), tabs);
}

/** Variant A: add the cascade's groups of 2+ tabs from the leftovers. */
function addCategories(tabs, groups) {
  const placed = new Set(groups.flat());
  const leftover = tabs.filter(tab => !placed.has(tab.id));
  if (leftover.length < 2) return groups;
  const plan = planGroups(leftover, inferredLabels(leftover), { locked: [] });
  const candidates = plan.groups
    .filter(group => group.kind !== 'review' && group.name !== REVIEW_GROUP_NAME && group.tabIds.length >= 2)
    .map((group, order) => ({ ids: group.tabIds, order }))
    .sort((x, y) => y.ids.length - x.ids.length || x.order - y.order);
  const out = groups.map(group => [...group]);
  let remaining = leftover.length;
  for (const item of candidates) {
    // Ten groups counting Review Later: nine groups while any tab stays unassigned.
    const fits = out.length < MAX_GROUPS - 1 || (out.length === MAX_GROUPS - 1 && item.ids.length === remaining);
    if (!fits) continue;
    out.push([...item.ids]);
    remaining -= item.ids.length;
  }
  return out;
}

/** Measures of a plan (groups of tab ids) on a window. */
function measure(tabs, groups) {
  const n = tabs.length;
  const assignment = new Map();
  groups.forEach((group, index) => group.forEach(id => assignment.set(id, index)));
  const unassigned = n - assignment.size;
  const largest = Math.max(0, ...groups.map(group => group.length));
  return {
    all: pairF1(assignment, tabs, 'all').f1,
    tasked: pairF1(assignment, tabs, 'tasked').f1,
    review: unassigned / n,
    largest: largest / n,
    groups: groups.length + (unassigned > 0 ? 1 : 0),
    realGroups: groups.length
  };
}
const measureApplied = (tabs, applied) => measure(tabs, applied.groups.map(group => group.ids));

// ---- self-check: the copy reproduces the engine ------------------------------------
function selfCheck(tabs, vectors) {
  const engine = clusterTabs(tabs, { vectors }).groups.map(group => group.tabIds);
  const mine = clusterGroups(tabs, vectors, 0);
  if (JSON.stringify(engine) !== JSON.stringify(mine)) throw new Error('copied linkage differs from clusterTabs');
}

// ---- twelve windows ----------------------------------------------------------------
const vectorCache = Object.fromEntries(names.map(name => [name, vectorsFor(windows[name])]));
const CHANNELS = { words: name => null, vectors: name => vectorCache[name] };

const planFor = (channel, variant, name) => {
  const tabs = windows[name];
  const vectors = CHANNELS[channel](name);
  const delta = variant.delta || 0;
  const base = clusterGroups(tabs, vectors, delta);
  return variant.categories ? addCategories(tabs, base) : base;
};

const results = { windows: {}, deltas: DELTAS, sizes: SIZES, subsets: SUBSETS };
const summarise = perWindow => {
  const list = names.map(name => perWindow[name]);
  return {
    all: meanOf(list.map(row => row.all)),
    tasked: meanOf(list.map(row => row.tasked)),
    reviewMean: meanOf(list.map(row => row.review)),
    reviewMax: Math.max(...list.map(row => row.review)),
    largestMean: meanOf(list.map(row => row.largest)),
    largestMax: Math.max(...list.map(row => row.largest)),
    groups: meanOf(list.map(row => row.groups)),
    perWindow
  };
};

const runVariant = (channel, variant) => summarise(Object.fromEntries(names.map(name => [name, measure(windows[name], planFor(channel, variant, name))])));

for (const channel of Object.keys(CHANNELS)) {
  for (const name of names) selfCheck(windows[name], CHANNELS[channel](name));
  const rows = {};
  rows.baseline = runVariant(channel, {});
  rows.A = runVariant(channel, { categories: true });
  for (const delta of DELTAS) rows[`B+${delta}`] = runVariant(channel, { delta });
  // Best B: in-sample (one delta over all windows), and leave-one-window-out.
  const inSample = DELTAS.reduce((best, delta) => (rows[`B+${delta}`].all > rows[`B+${best}`].all ? delta : best), DELTAS[0]);
  const folds = {};
  for (const name of names) {
    const others = names.filter(other => other !== name);
    folds[name] = DELTAS.reduce((best, delta) => {
      const score = meanOf(others.map(other => rows[`B+${delta}`].perWindow[other].all));
      return score > meanOf(others.map(other => rows[`B+${best}`].perWindow[other].all)) ? delta : best;
    }, DELTAS[0]);
  }
  rows.bestB = { ...rows[`B+${inSample}`], delta: inSample };
  rows.looB = summarise(Object.fromEntries(names.map(name => [name, rows[`B+${folds[name]}`].perWindow[name]])));
  rows.looB.deltas = folds;
  rows.AB = runVariant(channel, { categories: true, delta: inSample });
  rows.AB.delta = inSample;
  // A with the leave-one-window-out B
  rows.ABloo = summarise(Object.fromEntries(names.map(name => [name, measure(windows[name], planFor(channel, { categories: true, delta: folds[name] }, name))])));
  results.windows[channel] = rows;
}

// the old rule cascade alone on the twelve windows (sanity: 0.18 expected on all tabs)
results.rulesWindows = summarise(Object.fromEntries(names.map(name => [name, measureApplied(windows[name], rulesApplied(windows[name]))])));

// ---- small windows -----------------------------------------------------------------
function subsetOf(tabs, size, random) {
  const pool = tabs.map((_, index) => index);
  for (let i = 0; i < size; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const chosen = pool.slice(0, size).sort((a, b) => a - b).map(index => tabs[index]);
  const counts = new Map();
  for (const tab of chosen) if (tab.task) counts.set(tab.task, (counts.get(tab.task) || 0) + 1);
  return chosen.map(tab => (tab.task && counts.get(tab.task) < 2 ? { ...tab, task: null } : tab));
}

const hasGoldPair = tabs => {
  const counts = new Map();
  for (const tab of tabs) if (tab.task) counts.set(tab.task, (counts.get(tab.task) || 0) + 1);
  return [...counts.values()].some(count => count >= 2);
};

results.small = {};
for (const size of SIZES) {
  const acc = { words: { baseline: [], A: [] }, vectors: { baseline: [], A: [] }, rules: [] };
  let noGold = 0;
  let total = 0;
  for (const name of names) {
    if (windows[name].length < size) throw new Error(`${name} is smaller than ${size}`);
    const random = mulberry32((seedFor(name) * 31 + size) >>> 0);
    for (let k = 0; k < SUBSETS; k++) {
      const tabs = subsetOf(windows[name], size, random);
      total++;
      if (!hasGoldPair(tabs)) noGold++;
      for (const channel of ['words', 'vectors']) {
        const vectors = channel === 'vectors' ? vectorsFor(tabs) : null;
        const base = clusterGroups(tabs, vectors, 0);
        acc[channel].baseline.push(measure(tabs, base));
        acc[channel].A.push(measure(tabs, addCategories(tabs, base)));
      }
      acc.rules.push(measureApplied(tabs, rulesApplied(tabs)));
    }
  }
  const stats = list => ({
    all: meanOf(list.map(row => row.all)),
    tasked: meanOf(list.map(row => row.tasked)),
    reviewMean: meanOf(list.map(row => row.review)),
    reviewMax: Math.max(...list.map(row => row.review)),
    largestMean: meanOf(list.map(row => row.largest)),
    largestMax: Math.max(...list.map(row => row.largest)),
    groups: meanOf(list.map(row => row.groups)),
    // every tab in Review Later, or in one single group: at most one real group
    degenerate: list.filter(row => row.realGroups <= 1).length / list.length,
    allReview: list.filter(row => row.realGroups === 0).length / list.length
  });
  results.small[size] = {
    subsets: total,
    noGoldPair: noGold / total,
    words: { baseline: stats(acc.words.baseline), A: stats(acc.words.A) },
    vectors: { baseline: stats(acc.vectors.baseline), A: stats(acc.vectors.A) },
    rules: stats(acc.rules)
  };
}

// ---- report ------------------------------------------------------------------------
const f4 = value => value.toFixed(4);
const f3 = value => value.toFixed(3);
const pct = value => `${(value * 100).toFixed(1)}%`;
const ROW_LABELS = [
  ['baseline', 'Baseline'],
  ['A', 'A: categories for leftovers'],
  ['B+0.05', 'B +0.05'],
  ['B+0.1', 'B +0.1'],
  ['B+0.2', 'B +0.2'],
  ['looB', 'B leave-one-window-out'],
  ['AB', 'A + best B (in-sample)'],
  ['ABloo', 'A + B (leave-one-window-out)']
];

const lines = [
  '# Local engine variants',
  '',
  'Generated by `node eval/local-variants.mjs <models dir>`. Evaluation only: no product change. Twelve windows, all-tab and tasked pairwise F1 under `eval/scoring.mjs`.',
  'Review share = tabs left unassigned (in Review Later) / window tabs. Largest share = largest real group / window tabs. Groups = applied groups counting Review Later when any tab is unassigned.',
  `Variant B thresholds are tau + delta (title words tau ${LOCAL_SETTINGS.words.tau}, table tau ${LOCAL_SETTINGS.vectors.tau}). "Best B" is the in-sample best delta by mean all-tab F1; "leave-one-window-out" picks each window's delta from the other eleven windows only. Variant A runs the old cascade on the leftover tabs alone.`
];
const tableOf = (channel, title) => {
  const rows = results.windows[channel];
  const out = ['', `## ${title}`, '',
    '| Variant | F1 all | F1 tasked | Review share mean | max | Largest group mean | max | Groups |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const [key, label] of ROW_LABELS) {
    const row = rows[key];
    const extra = key === 'AB' ? ` (+${row.delta})` : '';
    out.push(`| ${label}${extra} | ${f4(row.all)} | ${f4(row.tasked)} | ${pct(row.reviewMean)} | ${pct(row.reviewMax)} | ${pct(row.largestMean)} | ${pct(row.largestMax)} | ${row.groups.toFixed(1)} |`);
  }
  const picked = new Set(Object.values(rows.looB.deltas));
  out.push('', `In-sample best delta: +${rows.bestB.delta}. Leave-one-window-out: ${picked.size === 1 ? `the other eleven windows pick +${[...picked][0]} in every fold, so the leave-one-window-out rows equal the in-sample best` : names.map(name => `${name} +${rows.looB.deltas[name]}`).join(', ')}.`);
  out.push('', `Per window, all-tab F1 (tasked F1 in brackets), review share, largest share:`, '',
    '| Window | Tabs | ' + ROW_LABELS.filter(([key]) => key !== 'looB' && key !== 'ABloo').map(([, label]) => label).join(' | ') + ' |',
    '| --- | ---: |' + ROW_LABELS.filter(([key]) => key !== 'looB' && key !== 'ABloo').map(() => ' ---: |').join(''));
  for (const name of names) {
    const cells = ROW_LABELS.filter(([key]) => key !== 'looB' && key !== 'ABloo').map(([key]) => {
      const row = rows[key].perWindow[name];
      return `${f3(row.all)} (${f3(row.tasked)}) / ${pct(row.review)} / ${pct(row.largest)}`;
    });
    out.push(`| ${name} | ${windows[name].length} | ${cells.join(' | ')} |`);
  }
  return out;
};
lines.push(...tableOf('words', 'Title words only'), ...tableOf('vectors', 'With the 4M table'));
lines.push('', `Old rule cascade alone on the twelve windows: F1 all ${f4(results.rulesWindows.all)}, tasked ${f4(results.rulesWindows.tasked)}, review share mean ${pct(results.rulesWindows.reviewMean)}, largest group mean ${pct(results.rulesWindows.largestMean)}.`);

lines.push('', '## Small windows', '',
  `${SUBSETS} seeded random subsets per fixture window (mulberry32, seed = window seed x 31 + size), gold tasks kept, a task left with one tab treated as loose; averaged over subsets and windows (${names.length * SUBSETS} subsets per size). F1 follows the scoring policy, so a subset with no gold pair scores 0 for every method (share of such subsets in the last column). "One group or fewer" = every tab in Review Later or in one single group (zero or one real group); "all in Review Later" is the zero-group part of it.`, '',
  '| Size | Method | F1 all | F1 tasked | Review share mean | max | Largest group mean | max | Groups | One group or fewer | All in Review Later | No gold pair |',
  '| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const size of SIZES) {
  const block = results.small[size];
  const entries = [
    ['Baseline, title words', block.words.baseline],
    ['A, title words', block.words.A],
    ['Baseline, 4M table', block.vectors.baseline],
    ['A, 4M table', block.vectors.A],
    ['Old rule cascade alone', block.rules]
  ];
  for (const [label, row] of entries) {
    lines.push(`| ${size} | ${label} | ${f4(row.all)} | ${f4(row.tasked)} | ${pct(row.reviewMean)} | ${pct(row.reviewMax)} | ${pct(row.largestMean)} | ${pct(row.largestMax)} | ${row.groups.toFixed(2)} | ${pct(row.degenerate)} | ${pct(row.allReview)} | ${pct(block.noGoldPair)} |`);
  }
}

// ---- reading -----------------------------------------------------------------------
const signed = value => `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;
const signedPct = value => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)} points`;
lines.push('', '## Reading', '');
for (const channel of ['words', 'vectors']) {
  const rows = results.windows[channel];
  const base = rows.baseline;
  lines.push(`**${channel === 'words' ? 'Title words only' : 'With the 4M table'}** (baseline all-tab F1 ${f4(base.all)}, review share mean ${pct(base.reviewMean)}, largest group mean ${pct(base.largestMean)}, max ${pct(base.largestMax)}):`);
  for (const [key, label] of ROW_LABELS.filter(([key]) => key !== 'baseline')) {
    const row = rows[key];
    const better = names.filter(name => row.perWindow[name].all > base.perWindow[name].all + 1e-12).length;
    const worse = names.filter(name => row.perWindow[name].all < base.perWindow[name].all - 1e-12).length;
    lines.push(`- ${label}: all-tab F1 ${signed(row.all - base.all)} (${f4(row.all)}), ${better} windows better, ${worse} worse, ${names.length - better - worse} unchanged; review share mean ${signedPct(row.reviewMean - base.reviewMean)}, max ${signedPct(row.reviewMax - base.reviewMax)}; largest group mean ${signedPct(row.largestMean - base.largestMean)}, max ${signedPct(row.largestMax - base.largestMax)}.`);
  }
  lines.push('');
}
lines.push('Small windows, by these numbers:');
for (const size of SIZES) {
  const block = results.small[size];
  const candidates = [
    ['baseline (title words)', block.words.baseline], ['A (title words)', block.words.A],
    ['baseline (4M table)', block.vectors.baseline], ['A (4M table)', block.vectors.A], ['old rule cascade alone', block.rules]
  ];
  const top = [...candidates].sort((x, y) => y[1].all - x[1].all)[0];
  const fewest = [...candidates].sort((x, y) => x[1].degenerate - y[1].degenerate)[0];
  const lowestReview = [...candidates].sort((x, y) => x[1].reviewMean - y[1].reviewMean)[0];
  lines.push(`- ${size} tabs: highest all-tab F1 ${top[0]} (${f4(top[1].all)}); fewest one-group-or-fewer subsets ${fewest[0]} (${pct(fewest[1].degenerate)}); lowest review share ${lowestReview[0]} (${pct(lowestReview[1].reviewMean)}).`);
}

const markdown = `${lines.join('\n')}\n`;
const strip = value => JSON.parse(JSON.stringify(value, (key, v) => (typeof v === 'number' ? round(v) : v)));
fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'results', 'local-variants.md'), markdown);
fs.writeFileSync(path.join(HERE, 'results', 'local-variants.json'), `${JSON.stringify(strip(results), null, 2)}\n`);
console.log(markdown);
