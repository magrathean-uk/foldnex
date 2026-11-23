// Phase 0, model-free half: every local grouping variant on every fixture
// window, with tunables chosen leave-one-window-out. Not product code.
//   node eval/run-local.mjs <models dir> [--titles <jsonl>] [--python <python with model2vec>] [--out <dir>]
// Writes <out>/local.json and local.md (default eval/results). Seeded and
// deterministic: two runs differ only in the "timing" block (and in date and
// commit when those change).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planGroups } from './legacy-labels.mjs';
import { inferredLabels, siteThenKeywordLabels } from './lib-legacy.mjs';
import { CLASSES, accuracy, argmax, classIndex, features, loadTitleSet, predict, randomSplit, siteSplit, train } from './local-classifier.mjs';
import { clusterAssignment, cut, dendrogram, tasksFromClusters } from './local-cluster.mjs';
import { measureTiming } from './local-timing.mjs';
import { REPS, attachCandidates, hiddenSet, upkeepScore } from './local-upkeep.mjs';
import {
  cosineMatrix, embed, goldLabels, keyOf, loadModel, loadWindows, pairScore,
  sparseMatrix, toInt8, urlWords
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

// --- arguments ----------------------------------------------------------------

const argv = process.argv.slice(2);
const option = name => {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  argv.splice(index, 2);
  return value;
};
const titlesPath = option('--titles') || process.env.FOLDNEX_TITLES || path.join(HERE, 'data', 'titles.jsonl');
const python = option('--python') || process.env.FOLDNEX_REF_PYTHON || null;
const outDir = option('--out') || path.join(HERE, 'results');
const MODELS_DIR = argv[0] || process.env.FOLDNEX_MODELS;
if (!MODELS_DIR) {
  console.error('Usage: node eval/run-local.mjs <dir holding potion-base-4M and -8M> [--titles f] [--python p] [--out d]');
  process.exit(2);
}

// --- grid ---------------------------------------------------------------------

const MODELS = ['potion-base-4M', 'potion-base-8M'];
const EMBEDS = [
  { idf: false, center: false }, { idf: true, center: false }, { idf: false, center: true }, { idf: true, center: true }
];
const WLS = [0, 0.5, 1];
const TAUS = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6];
const LAMBDAS = [1e-4, 1e-3, 1e-2, 1e-1];
const SMOOTH_K = [3, 6];
const COHERENCE = [0.2, 0.3, 0.4];
const SHARES = [0.1, 0.2, 0.3, 0.5];
const UPKEEP_SEEDS = 20;
const THETAS = [-Infinity, 0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7];
const SPLIT_SEED = 1;
const TRAIN_SEED = 1;

const round = value => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : value);
const meanOf = values => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
const sdOf = values => {
  const m = meanOf(values);
  return Math.sqrt(meanOf(values.map(value => (value - m) ** 2)));
};
const short = name => name.replace('potion-base-', '');
const affId = (e, wl) => `${e.idf ? 'idf' : 'raw'}${e.center ? '-ctr' : ''}-wl${wl}`;

// --- data ---------------------------------------------------------------------

const windows = await loadWindows();
const names = Object.keys(windows).sort();
console.log(`windows: ${names.map(name => `${name} (${windows[name].length})`).join(', ')}`);

let titleRows = null;
const titleInfo = { path: path.relative(ROOT, titlesPath), present: fs.existsSync(titlesPath) };
if (titleInfo.present) {
  const all = loadTitleSet(titlesPath);
  const urls = new Set();
  const titles = new Set();
  for (const name of names) {
    for (const tab of windows[name]) {
      urls.add(tab.url);
      titles.add(tab.title.trim().toLowerCase());
    }
  }
  titleRows = all.filter(row => !urls.has(row.url) && !titles.has(row.title.trim().toLowerCase()));
  Object.assign(titleInfo, { rows: all.length, droppedOverlapWithWindows: all.length - titleRows.length, used: titleRows.length });
  console.log(`title set: ${all.length} rows, ${titleInfo.droppedOverlapWithWindows} dropped as they match a window tab`);
} else {
  console.log(`title set: ${titleInfo.path} not found; classifier variants skipped`);
}

// --- per-window evaluation ------------------------------------------------------

/** Results per config key: {key, model, family parts, perWindow: {name: {p, r, f1, groups}}}. */
const configs = new Map();
function record(key, fields, name, result) {
  if (!configs.has(key)) configs.set(key, { key, ...fields, perWindow: {} });
  configs.get(key).perWindow[name] = { p: result.p, r: result.r, f1: result.f1, groups: result.groups };
}

const mapOf = (tabs, keys) => new Map(tabs.map((tab, index) => [tab.id, keys[index]]));

/** Dissolves unlocked token task groups whose mean pairwise cosine is below c; members join the closest remaining group. */
function coherenceAssignment(groups, tabs, S, c) {
  const n = tabs.length;
  const indexById = new Map(tabs.map((tab, index) => [tab.id, index]));
  const coherence = ids => {
    let sum = 0;
    let pairs = 0;
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        sum += S[indexById.get(ids[a]) * n + indexById.get(ids[b])];
        pairs++;
      }
    }
    return pairs ? sum / pairs : 1;
  };
  const keep = [];
  const loose = [];
  for (const group of groups) {
    if (!group.locked && group.kind === 'task' && coherence(group.tabIds) < c) loose.push(...group.tabIds);
    else keep.push(group);
  }
  if (!loose.length) return null;
  const assignment = new Map();
  keep.forEach((group, g) => group.tabIds.forEach(id => assignment.set(id, g)));
  for (const id of loose) {
    const i = indexById.get(id);
    let best = -Infinity;
    let choice = `s${id}`;
    keep.forEach((group, g) => {
      let sum = 0;
      for (const other of group.tabIds) sum += S[i * n + indexById.get(other)];
      const value = sum / group.tabIds.length;
      if (value > best) {
        best = value;
        choice = g;
      }
    });
    assignment.set(id, choice);
  }
  return assignment;
}

function assignmentOf(groups) {
  const assignment = new Map();
  groups.forEach((group, index) => group.tabIds.forEach(id => assignment.set(id, index)));
  return assignment;
}

const accuracyRows = {};
const classifierReport = {};
const upkeepRaw = {};
const trainedClassifiers = {};

for (const modelName of MODELS) {
  const m = short(modelName);
  const model = toInt8(loadModel(MODELS_DIR, modelName));
  console.log(`\n${modelName}: ${model.rows} rows x ${model.dim}, int8 with a scale per row`);

  // Classifier: held-out accuracy on the title set, then a model on all of it.
  const classifiers = {};
  if (titleRows) {
    const F = features(model, titleRows);
    const y = titleRows.map(row => classIndex(row.cat));
    const random = randomSplit(titleRows, SPLIT_SEED);
    const site = siteSplit(titleRows, SPLIT_SEED);
    classifierReport[m] = { trainRows: titleRows.length, randomTest: random.test.length, siteTest: site.test.length, byLambda: {} };
    for (const lambda of LAMBDAS) {
      const onRandom = train(F, y, random.train, { lambda, seed: TRAIN_SEED });
      const onSite = train(F, y, site.train, { lambda, seed: TRAIN_SEED });
      classifiers[lambda] = train(F, y, titleRows.map((_, index) => index), { lambda, seed: TRAIN_SEED });
      classifierReport[m].byLambda[lambda] = {
        heldOutRandom: accuracy(predict(onRandom, F), y, random.test),
        heldOutBySite: accuracy(predict(onSite, F), y, site.test),
        windows: {}
      };
    }
    trainedClassifiers[m] = classifiers;
  }

  for (const name of names) {
    const tabs = windows[name];
    const n = tabs.length;
    const pairs = tabs.map(tab => [tab.title, urlWords(tab.url)]);
    const plainS = cosineMatrix(embed(model, pairs));
    const sparse = sparseMatrix(tabs);

    // Affinities, dendrograms and task options.
    const vectorsByEmbed = EMBEDS.map(e => embed(model, pairs, e));
    const affinities = [];
    EMBEDS.forEach((e, ei) => {
      const dense = cosineMatrix(vectorsByEmbed[ei]);
      for (const wl of WLS) {
        const S = wl ? dense.map((value, index) => value + wl * sparse[index]) : dense;
        affinities.push({ e, wl, id: affId(e, wl), S, V: vectorsByEmbed[ei], merges: dendrogram(S, n) });
      }
    });
    const taskOptions = [{ id: 'none', tasks: [], params: null }];
    for (const a of affinities) {
      for (const tau of TAUS) {
        const clusters = cut(a.merges, n, tau);
        taskOptions.push({ id: `${a.id}-t${tau}`, tasks: tasksFromClusters(clusters, tabs), params: { ...a.e, wl: a.wl, tau } });
        record(`${m}|cluster|${a.id}-t${tau}`, { model: m, source: 'cluster', label: null, tasks: { ...a.e, wl: a.wl, tau }, coherence: null },
          name, pairScore(clusterAssignment(clusters, tabs), tabs));
      }
    }

    // Label sources.
    const sources = [
      { id: 'rules', source: 'rules', params: null, labels: inferredLabels(tabs), model: '-' },
      { id: 'gold', source: 'gold', params: null, labels: goldLabels(tabs), model: '-' },
      { id: 'kw', source: 'kw', params: null, labels: siteThenKeywordLabels(model, tabs), model: m }
    ];
    if (titleRows) {
      const siteLabels = [...inferredLabels(tabs)].filter(([, value]) => value.src === 'site');
      const tabFeatures = features(model, tabs);
      for (const lambda of LAMBDAS) {
        const probabilities = predict(classifiers[lambda], tabFeatures);
        const top = probabilities.map(p => CLASSES[argmax(p)]);
        sources.push({ id: `clf:${lambda}`, source: 'clf', params: { lambda }, labels: mapOf(tabs, top), model: m });
        const withSite = mapOf(tabs, top);
        for (const [id, value] of siteLabels) withSite.set(id, value.c);
        sources.push({ id: `siteclf:${lambda}`, source: 'siteclf', params: { lambda }, labels: withSite, model: m });
        for (const k of SMOOTH_K) {
          const smoothed = probabilities.map((p, i) => {
            const neighbours = Array.from({ length: n }, (_, j) => j).filter(j => j !== i)
              .sort((a, b) => plainS[i * n + b] - plainS[i * n + a] || a - b).slice(0, k);
            const q = Float64Array.from(p, value => 0.5 * value);
            for (const j of neighbours) for (let c = 0; c < q.length; c++) q[c] += (0.5 * probabilities[j][c]) / neighbours.length;
            return CLASSES[argmax(q)];
          });
          sources.push({ id: `smooth:${lambda}:k${k}`, source: 'smooth', params: { lambda, k }, labels: mapOf(tabs, smoothed), model: m });
        }
      }
    }

    accuracyRows[m] ??= {};
    accuracyRows[m][name] = Object.fromEntries(sources.map(src => [src.id, tabs.filter(tab => keyOf(src.labels.get(tab.id)) === tab.cat).length / n]));
    if (titleRows) for (const lambda of LAMBDAS) classifierReport[m].byLambda[lambda].windows[name] = accuracyRows[m][name][`clf:${lambda}`];

    // Planner runs: every label source with every task option, then the coherence check.
    // Model-free label sources (rules, gold) record their plain run once, under model '-';
    // anything that uses a table (tasks, the coherence check) is recorded per table.
    for (const src of sources) {
      const cache = new Map();
      for (const option of taskOptions) {
        const taskKey = option.tasks.map(task => task.tabIds.join(',')).join('|');
        let plan = cache.get(taskKey);
        if (!plan) {
          plan = planGroups(tabs, src.labels, { locked: option.tasks });
          cache.set(taskKey, plan);
        }
        const shared = src.model === '-' && option.id === 'none';
        const owner = shared ? '-' : m;
        const fields = { source: src.source, label: src.params, tasks: option.params };
        const base = pairScore(assignmentOf(plan.groups), tabs);
        if (!shared || modelName === MODELS[0]) record(`${owner}|${src.id}|${option.id}|coh-off`, { model: owner, ...fields, coherence: null }, name, base);
        for (const c of COHERENCE) {
          const assignment = coherenceAssignment(plan.groups, tabs, plainS, c);
          record(`${m}|${src.id}|${option.id}|coh${c}`, { model: m, ...fields, coherence: c }, name, assignment ? pairScore(assignment, tabs) : base);
        }
      }
    }

    // Plan upkeep: candidates for every affinity, share and seed.
    upkeepRaw[m] ??= {};
    upkeepRaw[m][name] = {};
    for (const a of affinities) {
      const perShare = SHARES.map((share, si) => Array.from({ length: UPKEEP_SEEDS }, (_, seed) => {
        const hidden = hiddenSet(tabs, share, 1000 * (si + 1) + seed + 1);
        return { hidden, candidates: attachCandidates(tabs, hidden, a.S, a.V, sparse, a.wl) };
      }));
      for (const rep of REPS) {
        for (const theta of THETAS) {
          upkeepRaw[m][name][`${a.id}|${rep}|${theta}`] = {
            affinity: { ...a.e, wl: a.wl }, rep, theta,
            shares: perShare.map(runs => {
              const scores = runs.map(run => upkeepScore(tabs, run.hidden, run.candidates, rep, theta));
              return {
                f1: meanOf(scores.map(s => s.f1)),
                attached: scores.reduce((sum, s) => sum + s.attached, 0),
                right: scores.reduce((sum, s) => sum + s.right, 0),
                total: scores.reduce((sum, s) => sum + s.total, 0)
              };
            })
          };
        }
      }
    }
    const none = perShareNoAttach(tabs);
    upkeepRaw[m][name].__none = none;
    console.log(`  ${name}: ${n} tabs, ${taskOptions.length} task options, ${sources.length} label sources`);
  }
}

function perShareNoAttach(tabs) {
  return SHARES.map((share, si) => meanOf(Array.from({ length: UPKEEP_SEEDS }, (_, seed) => {
    const hidden = hiddenSet(tabs, share, 1000 * (si + 1) + seed + 1);
    const assignment = new Map(tabs.map((tab, index) => [tab.id, !hidden.has(index) && tab.task ? `g:${tab.task}` : `s:${tab.id}`]));
    return pairScore(assignment, tabs).f1;
  })));
}

// --- selection: leave one window out ----------------------------------------------

const f1Of = (config, name) => config.perWindow[name].f1;

/** Held-out choice per window and the in-sample best; candidates in a fixed order, first wins ties. */
function select(candidates) {
  const scoreAll = config => meanOf(names.map(name => f1Of(config, name)));
  let best = null;
  for (const config of candidates) if (!best || scoreAll(config) > scoreAll(best)) best = config;
  const perWindow = names.map(name => f1Of(best, name));
  const inSample = {
    mean: scoreAll(best), min: Math.min(...perWindow), max: Math.max(...perWindow), sd: sdOf(perWindow),
    perWindow: Object.fromEntries(names.map(name => [name, best.perWindow[name]])), setting: describe(best), key: best.key
  };
  if (names.length < 2) return { headline: null, heldOut: null, inSample, candidates: candidates.length };
  const heldOut = {};
  for (const held of names) {
    const others = names.filter(name => name !== held);
    let chosen = null;
    let chosenScore = -Infinity;
    for (const config of candidates) {
      const value = meanOf(others.map(name => f1Of(config, name)));
      if (value > chosenScore) {
        chosen = config;
        chosenScore = value;
      }
    }
    heldOut[held] = { f1: f1Of(chosen, held), key: chosen.key, setting: describe(chosen) };
  }
  const scores = names.map(name => heldOut[name].f1);
  return { headline: meanOf(scores), headlineMin: Math.min(...scores), headlineMax: Math.max(...scores), heldOut, inSample, candidates: candidates.length };
}

function describe(config) {
  const parts = [SOURCE_NAMES[config.source]];
  if (config.label?.lambda !== undefined) parts.push(`lambda ${config.label.lambda}`);
  if (config.label?.k) parts.push(`smooth k ${config.label.k}`);
  if (config.tasks) parts.push(`tasks ${config.tasks.idf ? 'idf' : 'no idf'}, ${config.tasks.center ? 'centred' : 'not centred'}, wl ${config.tasks.wl}, tau ${config.tasks.tau}`);
  else if (config.source !== 'cluster') parts.push('no task step');
  if (config.coherence !== null && config.coherence !== undefined) parts.push(`coherence ${config.coherence}`);
  return parts.join('; ');
}

const all = [...configs.values()];
const SOURCE_NAMES = {
  rules: 'Rules only (offline today)',
  gold: 'Gold categories through today\'s planner',
  kw: 'Site table + keyword centroids',
  clf: 'Classifier',
  siteclf: 'Site table + classifier',
  smooth: 'Classifier smoothed over 3 or 6 nearest tabs',
  cluster: 'Clusters as groups (no planner)'
};

function families(m) {
  const mine = config => config.model === m || config.model === '-';
  const of = source => all.filter(config => mine(config) && config.source === source);
  const out = [];
  for (const source of ['rules', 'gold', 'kw', 'clf', 'siteclf', 'smooth']) {
    const list = of(source);
    if (!list.length) continue;
    out.push({ id: `${source}`, name: SOURCE_NAMES[source], list: list.filter(c => !c.tasks && c.coherence === null) });
    out.push({ id: `${source}+coherence`, name: `${SOURCE_NAMES[source]} + coherence check (no tasks)`, list: list.filter(c => !c.tasks) });
    out.push({ id: `${source}+tasks`, name: `${SOURCE_NAMES[source]} + semantic tasks`, list: list.filter(c => c.tasks && c.coherence === null) });
    out.push({ id: `${source}+all`, name: `${SOURCE_NAMES[source]}, tasks and coherence switches free`, list });
  }
  out.push({ id: 'cluster', name: SOURCE_NAMES.cluster, list: of('cluster') });
  out.push({ id: 'local', name: 'Local floor: every model-free variant', list: all.filter(config => mine(config) && config.source !== 'gold') });
  return out.filter(family => family.list.length);
}

const selection = {};
for (const modelName of MODELS) {
  const m = short(modelName);
  selection[m] = Object.fromEntries(families(m).map(family => [family.id, { name: family.name, ...select(family.list) }]));
}
selection.either = {
  local: { name: 'Local floor: every model-free variant, either table', ...select(all.filter(config => config.source !== 'gold')) }
};

// Top settings by in-sample mean, per table, for the lead's inspection.
const topSettings = {};
for (const modelName of MODELS) {
  const m = short(modelName);
  topSettings[m] = all.filter(config => (config.model === m || config.model === '-') && config.source !== 'gold')
    .map(config => ({ config, mean: meanOf(names.map(name => f1Of(config, name))) }))
    .sort((a, b) => b.mean - a.mean || (a.config.key < b.config.key ? -1 : 1))
    .slice(0, 15)
    .map(({ config, mean }) => ({ key: config.key, setting: describe(config), mean, perWindow: Object.fromEntries(names.map(name => [name, config.perWindow[name].f1])) }));
}

// --- upkeep selection -------------------------------------------------------------

const upkeep = {};
for (const modelName of MODELS) {
  const m = short(modelName);
  const keys = Object.keys(upkeepRaw[m][names[0]]).filter(key => key !== '__none');
  const objective = (key, list) => meanOf(list.map(name => meanOf(upkeepRaw[m][name][key].shares.map(s => s.f1))));
  const summarise = (key, list) => SHARES.map((share, si) => {
    const rows = list.map(name => upkeepRaw[m][name][key].shares[si]);
    return {
      share,
      f1: meanOf(rows.map(row => row.f1)),
      precision: rows.some(row => row.attached) ? meanOf(rows.filter(row => row.attached).map(row => row.right / row.attached)) : null,
      coverage: meanOf(rows.map(row => row.attached / (row.total || 1)))
    };
  });
  let best = null;
  for (const key of keys) if (!best || objective(key, names) > objective(best, names)) best = key;
  const raw = upkeepRaw[m][names[0]][best];
  const report = {
    noAttach: SHARES.map((share, si) => ({ share, f1: meanOf(names.map(name => upkeepRaw[m][name].__none[si])) })),
    attachAll: (() => {
      let top = null;
      for (const key of keys.filter(k => k.endsWith('|-Infinity'))) if (!top || objective(key, names) > objective(top, names)) top = key;
      return { key: top, shares: summarise(top, names) };
    })(),
    inSample: { key: best, affinity: raw.affinity, rep: raw.rep, theta: raw.theta, shares: summarise(best, names) },
    heldOut: null
  };
  if (names.length >= 2) {
    const perWindow = {};
    for (const held of names) {
      const others = names.filter(name => name !== held);
      let chosen = null;
      for (const key of keys) if (!chosen || objective(key, others) > objective(chosen, others)) chosen = key;
      perWindow[held] = { key: chosen, shares: summarise(chosen, [held]) };
    }
    report.heldOut = {
      perWindow,
      shares: SHARES.map((share, si) => ({
        share,
        f1: meanOf(names.map(name => perWindow[name].shares[si].f1)),
        precision: (list => (list.length ? meanOf(list) : null))(names.map(name => perWindow[name].shares[si].precision).filter(Number.isFinite)),
        coverage: meanOf(names.map(name => perWindow[name].shares[si].coverage))
      }))
    };
  }
  upkeep[m] = report;
}

// --- reference check (carried forward when no Python is given) ---------------------

const jsonPath = path.join(outDir, 'local.json');
let previous = null;
try {
  previous = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
} catch {
  previous = null;
}
let refcheck = previous?.refcheck || null;
if (python) {
  const { refCheck } = await import('./local-refcheck.mjs');
  const result = refCheck(MODELS_DIR, python);
  refcheck = {
    date: new Date().toISOString().slice(0, 10), commit: gitCommit(), texts: result.texts, tokenIdMismatches: result.idMismatches.length,
    models: Object.fromEntries(Object.entries(result.models).map(([name, row]) => [name, { worst: row.worst, mean: row.mean, worstText: row.worstText }]))
  };
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
function gitDirty() {
  try {
    return execFileSync('git', ['status', '--porcelain', '--', 'eval', 'src', ':!eval/results'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
  } catch {
    return null;
  }
}

// --- timing -------------------------------------------------------------------------

console.log('\ntiming (cold runs in fresh processes)...');
const timing = { note: 'Node proxy timing of the label, lock and planner pipeline: site table + classifier labels, semantic task locks and the planner on a synthetic window. It is not the timing of the selected local pipeline (the 4M headline is cluster-only) nor of the bundled extension. Cold: fresh Node process, reading the table, int8 conversion, first plan; Node start-up and module import excluded. Warm: median of 20.', models: {} };
for (const modelName of MODELS) {
  const m = short(modelName);
  const local = selection[m].local.inSample;
  const tasks = configs.get(local.key).tasks || { idf: false, center: false, wl: 0.5, tau: 0.35 };
  const lambda = configs.get(local.key).label?.lambda ?? LAMBDAS[1];
  const clf = trainedClassifiers[m]?.[lambda] || null;
  timing.models[m] = { labels: clf ? `site table + classifier (lambda ${lambda})` : 'site table + keyword centroids', tasks, sizes: await measureTiming(MODELS_DIR, modelName, clf, tasks) };
}

// --- output -------------------------------------------------------------------------

const deep = value => {
  if (Array.isArray(value)) return value.map(deep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deep(v)]));
  return round(value);
};

const windowInfo = names.map(name => ({
  name, tabs: windows[name].length, tasks: new Set(windows[name].map(tab => tab.task).filter(Boolean)).size,
  untasked: windows[name].filter(tab => !tab.task).length
}));

const result = deep({
  date: new Date().toISOString().slice(0, 10),
  commit: gitCommit(),
  dirty: gitDirty(),
  models: MODELS.map(name => `${name} (int8, scale per row)`),
  windows: windowInfo,
  grid: { embeds: EMBEDS, wl: WLS, tau: TAUS, lambda: LAMBDAS, smoothK: SMOOTH_K, coherence: COHERENCE, upkeepShares: SHARES, upkeepSeeds: UPKEEP_SEEDS, theta: THETAS.map(String) },
  method: 'Pairwise P/R/F1 over tabs with a gold task; tabs without one are not scored (eval/results/rescore.md adds an all-tab score under one applied-result policy). Headline: leave one window out (pick the setting with the best mean F1 on the other windows, score the window left out), mean over windows. In-sample: the one setting best over all windows.',
  titleSet: titleInfo,
  classifier: classifierReport,
  labelAccuracy: accuracyRows,
  selection,
  topSettings,
  upkeep,
  refcheck,
  open: openIssues(),
  timing
});

function openIssues() {
  const list = [];
  if (!titleInfo.present) list.push(`Title set ${titleInfo.path} missing: classifier, site+classifier and smoothing variants not measured.`);
  if (names.length < 6) list.push(`Only ${names.length} windows present; leave-one-window-out choices rest on ${names.length - 1} window(s) each.`);
  if (!refcheck) list.push('Reference check not recorded: run with --python <python with model2vec>.');
  return list;
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
const md = markdown(result);
fs.writeFileSync(path.join(outDir, 'local.md'), md);
console.log(`\n${md}`);
console.log(`wrote ${path.relative(ROOT, jsonPath)} and local.md`);

// --- tables -------------------------------------------------------------------------

function markdown(r) {
  const f = value => (Number.isFinite(value) ? value.toFixed(2) : '-');
  const pct = value => (Number.isFinite(value) ? `${Math.round(value * 100)}%` : '-');
  const lines = [];
  lines.push('# Local grouping evaluation (Phase 0, model-free)', '');
  lines.push(`Generated by \`node eval/run-local.mjs\` on ${r.date} at ${r.commit}${r.dirty ? ' (uncommitted changes)' : ''}. Tables: ${r.models.join(', ')}.`);
  lines.push(`Windows: ${r.windows.map(w => `${w.name} (${w.tabs} tabs, ${w.tasks} tasks)`).join(', ')}. Title set: ${r.titleSet.present ? `${r.titleSet.used} rows used (${r.titleSet.droppedOverlapWithWindows} dropped as window tabs)` : 'missing'}.`);
  lines.push('', r.method, '');

  lines.push('## Grouping F1 by variant', '');
  lines.push('| Variant | Table | Held-out mean (headline) | Held-out range | In-sample best | In-sample range | Best fixed setting |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  const shown = new Set();
  for (const m of Object.keys(r.selection)) {
    for (const [id, row] of Object.entries(r.selection[m])) {
      const modelFree = id === 'rules' || id === 'gold';
      if (modelFree && shown.has(id)) continue;
      shown.add(id);
      lines.push(`| ${row.name} | ${modelFree ? '-' : m} | ${f(row.headline)} | ${row.headline === null ? '-' : `${f(row.headlineMin)}-${f(row.headlineMax)}`} | ${f(row.inSample.mean)} | ${f(row.inSample.min)}-${f(row.inSample.max)} | ${row.inSample.setting || '-'} |`);
    }
  }

  lines.push('', '## Per window (held-out F1 of the local floor; rules and gold categories for reference)', '');
  lines.push(`| Window | Rules | Gold categories | ${Object.keys(r.selection).map(m => `Local ${m}`).join(' | ')} |`);
  lines.push(`| --- | --- | --- | ${Object.keys(r.selection).map(() => '---').join(' | ')} |`);
  const first = Object.keys(r.selection)[0];
  for (const w of r.windows) {
    const cells = Object.keys(r.selection).map(m => f(r.selection[m].local.heldOut?.[w.name]?.f1));
    lines.push(`| ${w.name} | ${f(r.selection[first].rules.inSample.perWindow[w.name].f1)} | ${f(r.selection[first].gold.inSample.perWindow[w.name].f1)} | ${cells.join(' | ')} |`);
  }

  lines.push('', '## Label accuracy against gold categories', '');
  if (Object.keys(r.classifier).length) {
    lines.push('| Table | lambda | Held-out 20% (random) | Held-out 20% (by site) | Windows (mean) |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const [m, report] of Object.entries(r.classifier)) {
      for (const [lambda, row] of Object.entries(report.byLambda)) {
        lines.push(`| ${m} | ${lambda} | ${pct(row.heldOutRandom)} | ${pct(row.heldOutBySite)} | ${pct(meanOf(Object.values(row.windows)))} |`);
      }
    }
    lines.push('');
  } else {
    lines.push('Classifier not measured: no title set.', '');
  }
  const ids = Object.keys(Object.values(r.labelAccuracy)[0][r.windows[0].name]).filter(id => id !== 'gold');
  for (const [m, table] of Object.entries(r.labelAccuracy)) {
    lines.push(`Per window, ${m}:`, '', `| Window | ${ids.join(' | ')} |`, `| --- | ${ids.map(() => '---').join(' | ')} |`);
    for (const w of r.windows) lines.push(`| ${w.name} | ${ids.map(id => pct(table[w.name][id])).join(' | ')} |`);
    lines.push('');
  }

  lines.push('## Plan upkeep (gold groups as the stored plan, hidden tabs with a gold task attached by similarity, 20 seeds)', '');
  lines.push('Starts from ideal stored groups, so it is optimistic. `eval/results/rescore.md` replays upkeep from recorded model plans and attaches every hidden tab.', '');
  lines.push('| Table | Share new | Held-out F1 | Precision | Coverage | In-sample F1 | Attach all F1 | No attach F1 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [m, report] of Object.entries(r.upkeep)) {
    report.inSample.shares.forEach((row, si) => {
      const held = report.heldOut?.shares[si];
      lines.push(`| ${m} | ${pct(row.share)} | ${f(held?.f1)} | ${pct(held?.precision)} | ${pct(held?.coverage)} | ${f(row.f1)} | ${f(report.attachAll.shares[si].f1)} | ${f(report.noAttach[si].f1)} |`);
    });
  }
  for (const [m, report] of Object.entries(r.upkeep)) {
    lines.push('', `${m} in-sample upkeep setting: ${JSON.stringify(report.inSample.affinity)}, ${report.inSample.rep}, threshold ${report.inSample.theta}.`);
  }

  lines.push('', '## Timing: Node proxy of the label, lock and planner pipeline (ms, median)', '');
  lines.push('| Table | Tabs | Cold total | Cold load + int8 | Cold first plan | Warm |', '| --- | --- | --- | --- | --- | --- |');
  for (const [m, row] of Object.entries(r.timing.models)) {
    for (const [n, t] of Object.entries(row.sizes)) lines.push(`| ${m} | ${n} | ${t.coldMs.toFixed(0)} | ${t.coldLoadMs.toFixed(0)} | ${t.coldFirstPlanMs.toFixed(0)} | ${t.warmMs.toFixed(1)} |`);
  }
  lines.push('', r.timing.note);

  if (r.refcheck) {
    lines.push('', '## Embedder against Python model2vec', '');
    lines.push(`${r.refcheck.texts} texts, ${r.refcheck.date} at ${r.refcheck.commit}: worst cosine ${Object.entries(r.refcheck.models).map(([name, row]) => `${short(name)} ${row.worst.toFixed(4)}`).join(', ')}; token id mismatches ${r.refcheck.tokenIdMismatches}.`);
  }

  lines.push('', '## Reading', '');
  lines.push(...reading(r).map(line => `- ${line}`));
  if (r.open.length) lines.push('', '## Open', '', ...r.open.map(line => `- ${line}`));
  return `${lines.join('\n')}\n`;
}

function reading(r) {
  const f = value => (Number.isFinite(value) ? value.toFixed(2) : 'n/a');
  const f4 = value => (Number.isFinite(value) ? value.toFixed(4) : 'n/a');
  const tables = MODELS.map(short);
  const first = r.selection[tables[0]];
  const either = r.selection.either.local;
  const out = [];
  out.push(`Today: rules only ${f(first.rules.inSample.mean)} mean F1 (one fixed run). Gold categories through today's planner ${f(first.gold.inSample.mean)}: a control that feeds one gold semantic category per tab, not an upper bound on what the planner can express; with semantic tasks ${f(first['gold+tasks'].headline)} held-out (${tables[0]}).`);
  const fixedLine = tables.map(m => {
    const row = r.selection[m].local;
    const keys = new Set(Object.values(row.heldOut || {}).map(item => item.key));
    return keys.size === 1
      ? `${m} table ${f4(row.headline)} held-out, the same setting chosen in every fold (${row.inSample.setting})`
      : `${m} table ${f4(row.headline)} held-out, ${keys.size} different settings chosen across the folds`;
  });
  out.push(`Local headline, by scope, against the gate of 0.50: ${fixedLine.join('; ')}; table chosen inside the folds ${f4(either.headline)} held-out; best single setting over all windows ${f4(either.inSample.mean)} in-sample and optimistic by construction (${either.inSample.setting}). Quote the first with its table and setting fixed in advance.`);
  const clfLine = tables.map(m => {
    const s = r.selection[m];
    const report = r.classifier[m];
    if (!report) return `${m}: keyword centroids ${f(s['kw+tasks']?.headline)} with tasks`;
    const accs = Object.values(report.byLambda);
    return `${m}: classifier held-out accuracy up to ${Math.round(Math.max(...accs.map(a => a.heldOutRandom)) * 100)}% random / ${Math.round(Math.max(...accs.map(a => a.heldOutBySite)) * 100)}% by site; held-out F1 site+classifier with tasks ${f(s['siteclf+tasks']?.headline)}, keyword centroids with tasks ${f(s['kw+tasks']?.headline)}`;
  });
  out.push(`Label sources: ${clfLine.join('; ')}.`);
  const sources = ['rules', 'gold', 'kw', 'clf', 'siteclf', 'smooth'];
  const pairs = (a, b) => tables.map(m => `${m}: ${sources.filter(id => r.selection[m][`${id}${a}`] && r.selection[m][`${id}${b}`])
    .map(id => `${id} ${f(r.selection[m][`${id}${a}`].headline)} to ${f(r.selection[m][`${id}${b}`].headline)}`).join(', ')}`).join('; ');
  out.push(`Held-out F1 without and with the semantic task step, same label source and table (rules, gold categories, keyword centroids, classifier, site+classifier, smoothed classifier): ${pairs('', '+tasks')}.`);
  out.push(`Held-out F1 without and with the coherence check, no task step: ${pairs('', '+coherence')}. Smoothing as a label source, classifier against smoothed classifier: ${tables.map(m => (r.selection[m].clf && r.selection[m].smooth ? `${m} ${f(r.selection[m].clf.headline)} to ${f(r.selection[m].smooth.headline)} without tasks, ${f(r.selection[m]['clf+tasks'].headline)} to ${f(r.selection[m]['smooth+tasks'].headline)} with tasks` : `${m} n/a`)).join('; ')}. The "switches free" rows choose tasks, coherence and label settings together, so their difference from other rows is not attributed to any one of them.`);
  const up = r.upkeep[tables[0]];
  const held = up.heldOut?.shares || up.inSample.shares;
  out.push(`Upkeep from gold groups (${tables[0]}, held-out, optimistic): F1 ${held.map(row => `${Math.round(row.share * 100)}% new ${f(row.f1)}`).join(', ')}. Upkeep from recorded model plans is in rescore.md.`);
  const t200 = r.timing.models[tables[0]].sizes[200];
  out.push(`Node proxy timing (label, lock and planner pipeline, ${tables[0]}, 200 tabs): ${t200.warmMs.toFixed(0)} ms warm, ${t200.coldMs.toFixed(0)} ms cold. Not a timing of the selected pipeline or of the extension.`);
  return out;
}
