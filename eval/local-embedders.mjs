// Compare local embedders using the same seeded fixtures and selection as run-local.
// node eval/local-embedders.mjs <vectors.json> <minishlab models dir>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clusterAssignment, cut, dendrogram } from './local-cluster.mjs';
import { REPS, attachCandidates, hiddenSet, upkeepScore } from './local-upkeep.mjs';
import { cosineMatrix, embed, loadModel, loadWindows, pairScore, sparseMatrix, toInt8, unit, urlWords } from './lib.mjs';

const [file, modelsDir] = process.argv.slice(2);
if (!file || !modelsDir) throw new Error('Usage: node eval/local-embedders.mjs <vectors.json> <models dir>');
const input = JSON.parse(fs.readFileSync(file, 'utf8'));
const windows = await loadWindows();
const names = Object.keys(windows).sort();
const nonEnglish = new Set(['a-household', 'b-expat']);
const means = a => a.reduce((x, y) => x + y, 0) / a.length;
const EMBEDS = [{ idf: false, center: false }, { idf: true, center: false }, { idf: false, center: true }, { idf: true, center: true }];
const WLS = [0, 0.5, 1];
const TAUS = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6];
const SHARES = [0.1, 0.2, 0.3, 0.5];
const THETAS = [-Infinity, 0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7];
const affId = (e, wl) => `${e.idf ? 'idf' : 'raw'}${e.center ? '-ctr' : ''}-wl${wl}`;
const center = vectors => {
  const avg = new Float64Array(vectors[0].length);
  for (const v of vectors) for (let d = 0; d < avg.length; d++) avg[d] += v[d] / vectors.length;
  return vectors.map(v => unit(Float64Array.from(v, (x, d) => x - avg[d])));
};
function select(configs, windowNames, metric) {
  const score = (c, ns) => means(ns.map(n => metric(c, n)));
  const best = ns => configs.reduce((a, b) => score(b, ns) > score(a, ns) ? b : a);
  const inSample = best(windowNames);
  const heldOut = Object.fromEntries(windowNames.map(n => {
    const c = best(windowNames.filter(other => other !== n));
    return [n, { key: c.key, f1: metric(c, n) }];
  }));
  return { mean: means(windowNames.map(n => heldOut[n].f1)), heldOut,
    inSample: { key: inSample.key, mean: score(inSample, windowNames) } };
}
const models = {};
const entries = [
  ...['4M', '8M'].map(size => ({ name: `potion-base-${size}`, table: true, short: size, metadata: input.baselines?.[size] || {} })),
  ...Object.entries(input.models || {}).map(([name, data]) => ({ name, ...data }))
];
for (const entry of entries) {
  console.log(`Scoring ${entry.name}`);
  const model = entry.table ? toInt8(loadModel(modelsDir, entry.name)) : null;
  const configs = new Map();
  const upkeep = new Map();
  for (const name of names) {
    const tabs = windows[name], n = tabs.length, sparse = sparseMatrix(tabs);
    let variants;
    if (model) {
      const pairs = tabs.map(t => [t.title, urlWords(t.url)]);
      variants = EMBEDS.map(e => ({ e, V: embed(model, pairs, e) }));
    } else {
      const raw = entry.windows?.[name];
      if (!raw || raw.length !== n || raw.some(v => !Array.isArray(v) || v.length !== raw[0].length || v.some(x => !Number.isFinite(x)) || Math.abs(Math.hypot(...v) - 1) > 0.001)) throw new Error(`Invalid vectors: ${entry.name} ${name}`);
      variants = [{ e: { idf: false, center: false }, V: raw }, { e: { idf: false, center: true }, V: center(raw) }];
    }
    // Print three fixed tabs' five nearest neighbours under plain dense cosine.
    if (name === names[0]) {
      const S = cosineMatrix(variants[0].V);
      for (const i of [0, Math.floor(n / 3), Math.floor(2 * n / 3)]) {
        const neighbours = tabs.map((t, j) => ({ j, score: S[i * n + j] })).filter(x => x.j !== i).sort((a, b) => b.score - a.score || a.j - b.j).slice(0, 5);
        console.log(`  ${name}: ${tabs[i].title}\n    ${neighbours.map(x => `${tabs[x.j].title} (${x.score.toFixed(3)})`).join(' | ')}`);
      }
    }
    for (const { e, V } of variants) {
      const dense = cosineMatrix(V);
      for (const wl of WLS) {
        const id = affId(e, wl), S = wl ? dense.map((value, i) => value + wl * sparse[i]) : dense;
        const tree = dendrogram(S, n);
        for (const tau of TAUS) {
          const key = `${id}-t${tau}`;
          if (!configs.has(key)) configs.set(key, { key, perWindow: {} });
          configs.get(key).perWindow[name] = pairScore(clusterAssignment(cut(tree, n, tau), tabs), tabs).f1;
        }
        const perShare = SHARES.map((share, si) => Array.from({ length: 20 }, (_, seed) => {
          const hidden = hiddenSet(tabs, share, 1000 * (si + 1) + seed + 1);
          return { hidden, candidates: attachCandidates(tabs, hidden, S, V, sparse, wl) };
        }));
        for (const rep of REPS) for (const theta of THETAS) {
          const key = `${id}|${rep}|${theta}`;
          if (!upkeep.has(key)) upkeep.set(key, { key, perWindow: {} });
          upkeep.get(key).perWindow[name] = perShare.map(runs => means(runs.map(run => upkeepScore(tabs, run.hidden, run.candidates, rep, theta).f1)));
        }
      }
    }
  }
  const allConfigs = [...configs.values()];
  const cluster = select(allConfigs, names, (c, n) => c.perWindow[n]);
  cluster.english = means(names.filter(n => !nonEnglish.has(n)).map(n => cluster.heldOut[n].f1));
  cluster.nonEnglish = means(names.filter(n => nonEnglish.has(n)).map(n => cluster.heldOut[n].f1));
  const upkeepConfigs = [...upkeep.values()];
  const upSelection = select(upkeepConfigs, names, (c, n) => means(c.perWindow[n]));
  const byKey = new Map(upkeepConfigs.map(c => [c.key, c]));
  const upShares = SHARES.map((share, i) => ({ share, f1: means(names.map(n => byKey.get(upSelection.heldOut[n].key).perWindow[n][i])) }));
  const bestUp = byKey.get(upSelection.inSample.key);
  upSelection.shares = upShares;
  upSelection.inSample.shares = SHARES.map((share, i) => ({ share, f1: means(names.map(n => bestUp.perWindow[n][i])) }));
  const metadata = { ...entry.metadata };
  if (!model) {
    metadata.quantisedBytes = metadata.quantised_bytes;
    metadata.cpuMsPer100 = metadata.cpu_seconds_per_100 * 1000;
  }
  if (model) Object.assign(metadata, { parameters: model.rows * model.dim, dimension: model.dim, quantisedBytes: model.rows * model.dim + model.rows * 4, cpuMsPer100: entry.short === '4M' ? 2.3066 : 2.1697, sizeNote: 'int8 matrix and per-row scales; excludes tokenizer', runtime: 'Node warm single-thread CPU, 20 repetitions, first 100 fixture tabs' });
  metadata.tokenizerExtraMB = model ? 0.7 : entry.name.includes('multilingual-e5') ? 17.08 : entry.name.includes('embeddinggemma') ? 20.32 : 0.71;
  const twoWindow = model && ['dev', 'life'].every(n => names.includes(n)) ? select(allConfigs, ['dev', 'life'], (c, n) => c.perWindow[n]) : null;
  models[entry.name] = { metadata, cluster, upkeep: upSelection, twoWindowBaseline: twoWindow };
}
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
const local = JSON.parse(fs.readFileSync(path.join(outDir, 'local.json'), 'utf8'));
// The potion rows must reproduce the clusters-as-groups held-out headline of
// the current local.json, on the same windows (local.json rounds to 4 places).
const baselineCheck = {};
for (const size of ['4M', '8M']) {
  const actual = models[`potion-base-${size}`].cluster.mean;
  const expected = local.selection[size].cluster.headline;
  const localWindows = local.windows.map(w => w.name).sort();
  if (localWindows.join() !== names.join()) throw new Error(`local.json covers ${localWindows.join(', ')}, the fixtures ${names.join(', ')}: rerun run-local.mjs`);
  baselineCheck[size] = { actual, expected, difference: actual - expected, windows: names.length, note: 'Held-out cluster F1 over every fixture window against local.json selection.<size>.cluster.headline.' };
  console.log(`Baseline ${size}, ${names.length} windows: ${actual.toFixed(4)} vs local.json ${expected.toFixed(4)}`);
  if (Math.abs(actual - expected) > 5e-5) throw new Error(`Baseline ${size} differs from local.json`);
}
// Pilot comparison only, not a check: the same selection run on dev and life alone.
const pilotTwoWindow = Object.fromEntries(['4M', '8M'].map(size => [size, models[`potion-base-${size}`].twoWindowBaseline?.mean ?? null]));
const report = { protocol: { windows: names, nonEnglish: [...nonEnglish], shares: SHARES, seeds: 20, tau: TAUS, wl: WLS, theta: THETAS.map(String), text: 'Transformers concatenate title and URL words once; E5 uses query: and Gemma uses task: clustering | query:. Static tables weight URL tokens by 0.5', note: 'Upkeep chooses settings on mean F1 across all four shares, as run-local does. Timing is provided by vector-generation metadata. This compares pipelines (encoder, input text and idf/centring options), not encoders alone.' }, baselineCheck, pilotTwoWindow, skipped: input.skipped || {}, models };
fs.writeFileSync(path.join(outDir, 'embedders.json'), `${JSON.stringify(report, null, 2)}\n`);
const f = n => Number.isFinite(n) ? n.toFixed(3) : 'n/a';
const display = m => m.metadata;
const lines = ['# Local embedding comparison', '', `| Pipeline (encoder) | Parameters | Quantised weights | Dimension | CPU time / 100 texts | F1, ${names.length} windows | F1, ${names.length - nonEnglish.size} other windows | F1, mixed-language (${[...nonEnglish].join(', ')}) | Upkeep 20% | Upkeep 30% |`, '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
for (const [name, m] of Object.entries(models)) {
  const d = display(m);
  lines.push(`| ${name} | ${d.parameters == null ? 'n/a' : `${(d.parameters / 1e6).toFixed(1)}M`} | ${d.quantisedBytes == null ? 'n/a' : `${(d.quantisedBytes / 1e6).toFixed(1)} MB`} | ${d.dimension ?? 'n/a'} | ${d.cpuMsPer100 == null ? 'n/a' : `${Number(d.cpuMsPer100).toFixed(1)} ms`} | ${f(m.cluster.mean)} | ${f(m.cluster.english)} | ${f(m.cluster.nonEnglish)} | ${f(m.upkeep.shares[1].f1)} | ${f(m.upkeep.shares[2].f1)} |`);
}
const baselineBest = Math.max(...Object.entries(models).filter(([name]) => name.startsWith('potion-')).map(([, m]) => m.cluster.mean));
const transformers = Object.entries(models).filter(([name]) => !name.startsWith('potion-')).sort((a, b) => b[1].cluster.mean - a[1].cluster.mean);
if (transformers.length) {
  const delta = value => `${value >= 0 ? '+' : ''}${f(value)}`;
  lines.push('', `Best transformers against the better potion table: ${transformers.slice(0, 2).map(([name, m]) => `${name} ${delta(m.cluster.mean - baselineBest)} F1`).join('; ')}. The table shows their weight and inference costs.`);
}
lines.push('', 'This compares pipelines, not encoders alone: the encoder, the text it is given and the idf and centring options all differ between rows (see the last paragraph). A claim about an encoder alone needs matched inputs and search grids.', '', `In-sample cluster F1: ${Object.entries(models).map(([name, m]) => `${name} ${f(m.cluster.inSample.mean)}`).join('; ')}.`, `All F1 values are leave-one-window-out means over tabs with a gold task. The language split is two mixed-language windows (${[...nonEnglish].join(' and ')}) against the ${names.length - nonEnglish.size} others; both are subsets of the same held-out selections. In-sample bests and per-window choices are in JSON.`, `Upkeep uses gold groups (optimistic), four hide shares and 20 seeds; settings are selected jointly over all shares.`, `Check: both potion rows reproduce the held-out clusters-as-groups headline of the current local.json on all ${names.length} windows (${['4M', '8M'].map(size => `${size} ${baselineCheck[size].actual.toFixed(4)} against ${baselineCheck[size].expected.toFixed(4)}`).join(', ')}).`, `Sizes exclude tokenizers and runtimes: add about 0.7 MB for potion, 0.71 MB for MiniLM/BGE, 17.08 MB for E5 and 20.32 MB for Gemma.${Object.values(models).some(m => m.metadata.evaluated_weight_bytes && m.metadata.evaluated_weight_bytes !== m.metadata.quantisedBytes) ? ' Gemma’s 176.1 MB q4f16 export loaded successfully; its F1 and timing use the 197.2 MB q4 export.' : ''}`, `Transformers concatenate title and URL words once; E5 uses \`query:\` and Gemma uses \`task: clustering | query:\`. Potion weights URL tokens by 0.5 and its search includes idf and centring; the transformer search includes centring only. Timings exclude loading and compare Node with ONNX.`, ...Object.entries(input.skipped || {}).map(([name, reason]) => `${name} skipped: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}.`));
fs.writeFileSync(path.join(outDir, 'embedders.md'), `${lines.join('\n')}\n`);
