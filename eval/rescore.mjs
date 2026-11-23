// Phase 0 results under one scoring policy (eval/scoring.mjs). Every number
// comes from the fixtures, the recorded provider answers and the local
// harness; no model API, no network. Not product code.
//   node eval/rescore.mjs <models dir holding potion-base-4M> [--out <dir>]
// Writes <out>/rescore.json and rescore.md (default eval/results). Deterministic.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudLabelBatchSize, parseLabelResponse, planGroups } from './legacy-labels.mjs';
import { inferredLabels } from './lib-legacy.mjs';
import { cut, dendrogram } from './local-cluster.mjs';
import { groupScorer, hiddenSet } from './local-upkeep.mjs';
import { cosineMatrix, embed, goldLabels, loadModel, loadWindows, sparseMatrix, toInt8, urlWords } from './lib.mjs';
import { applyGroups, bothScores, pairCounts, pairF1, planGroupsOf, planValidity, prf } from './scoring.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
const outDir = outIndex >= 0 ? argv.splice(outIndex, 2)[1] : path.join(HERE, 'results');
const MODELS_DIR = argv[0] || process.env.FOLDNEX_MODELS;
if (!MODELS_DIR) {
  console.error('Usage: node eval/rescore.mjs <dir holding potion-base-4M> [--out <dir>]');
  process.exit(2);
}
const PROVIDER_DIR = path.join(HERE, 'results', 'provider', 'full');
const PROMPT_WINDOWS = new Set(['dev', 'life']); // used to draft the plan prompt
const SHARES = [0.1, 0.2, 0.3, 0.5];
const UPKEEP_SEEDS = 20; // the hidden sets of run-local.mjs: seed 1000 * (share index + 1) + seed + 1
const TOLERANCE = 5e-5; // recorded reports round to four decimals

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const meanOf = values => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
const round = value => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : value);
const deep = value => {
  if (Array.isArray(value)) return value.map(deep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deep(v)]));
  return round(value);
};

const windows = await loadWindows();
const names = Object.keys(windows).sort();
const clean = names.filter(name => !PROMPT_WINDOWS.has(name));
const local = readJson(path.join(HERE, 'results', 'local.json'));
const ablation = readJson(path.join(HERE, 'results', 'ablation.json'));
const model4M = toInt8(loadModel(MODELS_DIR, 'potion-base-4M'));

const mismatches = [];
function expectRecorded(row, name, mine, recorded) {
  if (recorded === undefined || Math.abs(mine - recorded) > TOLERANCE) mismatches.push(`${row} ${name}: replay ${mine} against recorded ${recorded}`);
}

/** Affinity of run-local.mjs from an id such as "idf-ctr-wl1": {S, V, sparse, wl}. */
const affinityCache = new Map();
function affinityOf(name, id) {
  const key = `${name}|${id}`;
  if (affinityCache.has(key)) return affinityCache.get(key);
  const match = /^(raw|idf)(-ctr)?-wl([\d.]+)$/.exec(id);
  if (!match) throw new Error(`Unknown affinity id ${id}`);
  const tabs = windows[name];
  const wl = Number(match[3]);
  const V = embed(model4M, tabs.map(tab => [tab.title, urlWords(tab.url)]), { idf: match[1] === 'idf', center: Boolean(match[2]) });
  const dense = cosineMatrix(V);
  const sparse = sparseMatrix(tabs);
  const value = { S: wl ? dense.map((v, index) => v + wl * sparse[index]) : dense, V, sparse, wl };
  affinityCache.set(key, value);
  return value;
}

const planGroupList = plan => plan.groups.map(group => ({ name: group.name, ids: group.tabIds }));
const groupIndex = groups => new Map(groups.flatMap((group, index) => group.ids.map(id => [id, index])));
const clusterGroups = (clusters, tabs) => clusters.filter(cluster => cluster.length >= 2).map((cluster, index) => ({ name: `Cluster ${index + 1}`, ids: cluster.map(i => tabs[i].id) }));
/** clusterAssignment() of local-cluster.mjs as groups: the ten largest clusters of 2+ tabs, as recorded. */
const recordedClusterGroups = (clusters, tabs) => clusters.map((cluster, order) => ({ cluster, order }))
  .sort((x, y) => y.cluster.length - x.cluster.length || x.order - y.order)
  .slice(0, 10).filter(({ cluster }) => cluster.length >= 2)
  .map(({ cluster }, rank) => ({ name: `c${rank}`, ids: cluster.map(i => tabs[i].id) }));

/**
 * One unit: a window and a method's groups. recorded = the groups as the
 * original reports scored them; applied = the scoring policy.
 */
function unitScores(tabs, recordedGroups, methodGroups) {
  const recorded = groupIndex(recordedGroups);
  const applied = applyGroups(methodGroups, tabs);
  const pooled = new Map(tabs.map(tab => [tab.id, applied.assignment.has(tab.id) ? applied.assignment.get(tab.id) : 'pool']));
  return {
    recordedTasked: pairF1(recorded, tabs, 'tasked').f1,
    asGivenAll: pairF1(recorded, tabs, 'all').f1,
    appliedTasked: pairF1(applied.assignment, tabs, 'tasked').f1,
    appliedAll: pairF1(applied.assignment, tabs, 'all').f1,
    pooledTasked: pairF1(pooled, tabs, 'tasked').f1,
    pooledAll: pairF1(pooled, tabs, 'all').f1,
    unassigned: applied.unassigned.length,
    capped: applied.dropped,
    applied
  };
}

const METRICS = ['recordedTasked', 'asGivenAll', 'appliedTasked', 'appliedAll', 'pooledTasked', 'pooledAll', 'unassigned', 'capped'];
/** Per-window means over a window's units, then means over twelve and over ten windows. */
function summarise(perWindowUnits) {
  const perWindow = Object.fromEntries(names.map(name => [name, Object.fromEntries(METRICS.map(metric => [metric, meanOf(perWindowUnits[name].map(unit => unit[metric]))]))]));
  const over = list => Object.fromEntries(METRICS.map(metric => [metric, meanOf(list.map(name => perWindow[name][metric]))]));
  return { twelve: over(names), ten: over(clean), perWindow };
}

const rows = [];

// --- local paths ------------------------------------------------------------------

for (const [id, label, labels, recordedOf] of [
  ['rules', 'Rules only (offline today)', inferredLabels, name => local.selection['4M'].rules.inSample.perWindow[name]?.f1],
  ['gold', 'Gold categories through today\'s planner', goldLabels, name => local.selection['4M'].gold.inSample.perWindow[name]?.f1]
]) {
  const units = {};
  for (const name of names) {
    const tabs = windows[name];
    const groups = planGroupList(planGroups(tabs, labels(tabs), { locked: [] }));
    units[name] = [unitScores(tabs, groups, groups)];
    expectRecorded(id, name, units[name][0].recordedTasked, recordedOf(name));
  }
  rows.push({ id, label, kind: 'local', ...summarise(units) });
}

{
  const channel = ablation.channels['lexical-title'].cluster;
  const units = {};
  const settings = {};
  for (const name of names) {
    const tabs = windows[name];
    settings[name] = channel.heldOutSettings[name];
    const tau = Number(settings[name].slice(settings[name].lastIndexOf('-t') + 2));
    const clusters = cut(dendrogram(sparseMatrix(tabs), tabs.length), tabs.length, tau);
    units[name] = [unitScores(tabs, recordedClusterGroups(clusters, tabs), clusterGroups(clusters, tabs))];
    expectRecorded('lexical-title', name, units[name][0].recordedTasked, channel.heldOut.perWindow[name]);
  }
  rows.push({ id: 'lexical-title', label: 'Clusters on title words only (held-out settings)', kind: 'local', settings, ...summarise(units) });
}

{
  const family = local.selection['4M'].cluster;
  const units = {};
  const settings = {};
  for (const name of names) {
    const tabs = windows[name];
    settings[name] = family.heldOut[name].key;
    const match = /^4M\|cluster\|(.+)-t([\d.]+)$/.exec(settings[name]);
    const { S } = affinityOf(name, match[1]);
    const clusters = cut(dendrogram(S, tabs.length), tabs.length, Number(match[2]));
    units[name] = [unitScores(tabs, recordedClusterGroups(clusters, tabs), clusterGroups(clusters, tabs))];
    expectRecorded('cluster-4M', name, units[name][0].recordedTasked, family.heldOut[name].f1);
  }
  rows.push({ id: 'cluster-4M', label: 'Clusters with the 4M table (idf, wl 1, tau 0.2)', kind: 'local', settings, ...summarise(units) });
}

// --- recorded provider answers ---------------------------------------------------------

const runFiles = fs.readdirSync(PROVIDER_DIR).filter(file => file.endsWith('.json')).sort();
const runs = runFiles.map(file => ({ file, ...readJson(path.join(PROVIDER_DIR, file)) }));
const runLabel = run => {
  const who = run.model.replace('claude-', '').replace(/-5-5$/, '').replace(/^./, c => c.toUpperCase());
  if (run.mode === 'labels') return `${who} labels`;
  if (!run.effort && run.effort_sent) return `${who} plan, effort ${run.effort_sent} (thinking omitted)`;
  return `${who} plan, ${run.effort ? `thinking ${run.thinking} / effort ${run.effort}` : `thinking ${run.thinking}`}`;
};
const runId = run => `${run.model}|${run.mode}|${run.thinking}${run.effort ? `-${run.effort}` : ''}`;
const ORDER = ['claude-haiku-5-5|labels|off', 'claude-haiku-5-5|plan|off', 'claude-haiku-5-5|plan|adaptive-low', 'claude-sonnet-5-5|plan|off', 'claude-sonnet-5-5|plan|adaptive-low', 'claude-opus-5-5|plan|off'];
runs.sort((a, b) => ORDER.indexOf(runId(a)) - ORDER.indexOf(runId(b)));

const validity = [];
const appliedPlans = {}; // runId -> window -> [applied]
const givenPlans = {}; // runId -> window -> [groups as given, Review Later kept, no cap]
for (const run of runs) {
  const id = runId(run);
  const units = Object.fromEntries(names.map(name => [name, []]));
  const checks = [];
  appliedPlans[id] = Object.fromEntries(names.map(name => [name, []]));
  givenPlans[id] = Object.fromEntries(names.map(name => [name, []]));
  for (const unit of run.units) {
    if (unit.failed) continue;
    const tabs = windows[unit.window];
    let groups;
    if (run.mode === 'labels') {
      const size = cloudLabelBatchSize(tabs.length);
      const byId = new Map();
      let unknown = 0;
      let invalid = 0;
      unit.answer.forEach((answer, b) => {
        const batch = tabs.slice(b * size, b * size + size);
        const parsed = parseLabelResponse(answer, batch.length);
        for (const [ordinal, key] of parsed) byId.set(batch[ordinal].id, key);
        for (const raw of Object.keys(answer || {})) {
          const ordinal = Number(raw);
          if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= batch.length || String(ordinal) !== raw) unknown++;
          else if (!parsed.has(ordinal)) invalid++;
        }
      });
      groups = planGroupList(planGroups(tabs, byId, { locked: [] }));
      checks.push({ window: unit.window, tabs: tabs.length, omitted: tabs.length - byId.size, duplicates: 0, unknown, invalidLabels: invalid, folders: null, overLimit: false });
    } else {
      groups = planGroupsOf(unit.answer, tabs);
      checks.push({ window: unit.window, tabs: tabs.length, ...planValidity(unit.answer, tabs) });
    }
    // Recorded scoring: first placement wins, omitted tabs singletons, every folder kept.
    const recordedGroups = run.mode === 'labels' ? groups : (() => {
      const seen = new Set();
      return groups.map(group => ({ name: group.name, ids: group.ids.filter(tabId => tabId !== null && !seen.has(tabId) && seen.add(tabId)) }));
    })();
    const scores = unitScores(tabs, recordedGroups, groups);
    expectRecorded(id, `${unit.window}#${unit.repeat}`, scores.recordedTasked, unit.score.f1);
    units[unit.window].push(scores);
    appliedPlans[id][unit.window].push(scores.applied);
    givenPlans[id][unit.window].push(recordedGroups.filter(group => group.ids.length));
  }
  rows.push({ id, label: runLabel(run), kind: 'provider', file: run.file, ...summarise(units) });
  const worst = checks.reduce((top, check) => (check.omitted > top.omitted ? check : top), checks[0]);
  validity.push({
    id, label: runLabel(run), runs: checks.length,
    withOmitted: checks.filter(c => c.omitted > 0).length,
    withDuplicates: checks.filter(c => c.duplicates > 0).length,
    withUnknown: checks.filter(c => c.unknown > 0).length,
    withInvalidLabels: run.mode === 'labels' ? checks.filter(c => c.invalidLabels > 0).length : null,
    overLimit: run.mode === 'labels' ? null : checks.filter(c => c.overLimit).length,
    maxFolders: run.mode === 'labels' ? null : Math.max(...checks.map(c => c.folders)),
    worstOmission: { omitted: worst.omitted, tabs: worst.tabs, window: worst.window }
  });
}

if (mismatches.length) {
  console.error(`Replay differs from the recorded reports:\n${mismatches.join('\n')}`);
  process.exit(1);
}

// --- paired Haiku comparison (applied, all tabs) -------------------------------------------

const rowById = Object.fromEntries(rows.map(row => [row.id, row]));
const labelsRow = rowById['claude-haiku-5-5|labels|off'];
const planOffRow = rowById['claude-haiku-5-5|plan|off'];
const paired = names.map(name => ({ window: name, labels: labelsRow.perWindow[name].appliedAll, plan: planOffRow.perWindow[name].appliedAll }));
const pairedSummary = {
  planBetter: paired.filter(row => row.plan > row.labels).length,
  planBetterTen: paired.filter(row => clean.includes(row.window) && row.plan > row.labels).length,
  windows: names.length,
  meanLabels: meanOf(paired.map(row => row.labels)),
  meanPlan: meanOf(paired.map(row => row.plan))
};

// --- upkeep from recorded plans ------------------------------------------------------------

const upkeepSettings = Object.fromEntries(names.map(name => [name, local.upkeep['4M'].heldOut.perWindow[name].key]));
const goldUpkeepRecorded = local.upkeep['4M'].heldOut.shares.map(row => row.f1);

/** Upkeep of one stored plan (groups of tab ids, applied) on one window, over every share and seed. */
function upkeepOf(name, storedGroups) {
  const tabs = windows[name];
  const indexById = new Map(tabs.map((tab, index) => [tab.id, index]));
  const [affinity, rep, thetaText] = upkeepSettings[name].split('|');
  const theta = Number(thetaText);
  const { S, V, sparse, wl } = affinityOf(name, affinity);
  return SHARES.map((share, si) => {
    const totals = { tasked: 0, all: 0, noAttachTasked: 0, noAttachAll: 0, changedTasked: 0, looseHidden: 0, looseAttached: 0, taskedHidden: 0, taskedAttached: 0 };
    for (let seed = 0; seed < UPKEEP_SEEDS; seed++) {
      const hidden = hiddenSet(tabs, share, 1000 * (si + 1) + seed + 1);
      const stored = storedGroups
        .map((group, g) => ({ key: g, members: group.ids.map(id => indexById.get(id)).filter(i => !hidden.has(i)) }))
        .filter(group => group.members.length);
      const noAttach = new Map();
      for (const group of stored) for (const i of group.members) noAttach.set(tabs[i].id, group.key);
      const assignment = new Map(noAttach);
      const best = groupScorer(stored, S, V, sparse, wl);
      for (const i of [...hidden].sort((a, b) => a - b)) {
        const choice = stored.length ? best(i, rep) : { group: null, score: -Infinity };
        const attach = choice.group !== null && choice.score >= theta;
        if (attach) assignment.set(tabs[i].id, choice.group);
        if (tabs[i].task) {
          totals.taskedHidden++;
          if (attach) totals.taskedAttached++;
        } else {
          totals.looseHidden++;
          if (attach) totals.looseAttached++;
        }
      }
      const survivors = tabs.filter((tab, index) => !hidden.has(index));
      const whole = pairCounts(assignment, tabs, 'tasked');
      const old = pairCounts(assignment, survivors, 'tasked');
      totals.tasked += prf(whole).f1;
      totals.all += pairF1(assignment, tabs, 'all').f1;
      totals.noAttachTasked += pairF1(noAttach, tabs, 'tasked').f1;
      totals.noAttachAll += pairF1(noAttach, tabs, 'all').f1;
      totals.changedTasked += prf({ tp: whole.tp - old.tp, predicted: whole.predicted - old.predicted, gold: whole.gold - old.gold }).f1;
    }
    const per = key => totals[key] / UPKEEP_SEEDS;
    return {
      share, tasked: per('tasked'), all: per('all'), noAttachTasked: per('noAttachTasked'), noAttachAll: per('noAttachAll'), changedTasked: per('changedTasked'),
      looseHidden: totals.looseHidden, looseAttached: totals.looseAttached, taskedHidden: totals.taskedHidden, taskedAttached: totals.taskedAttached
    };
  });
}

/** Means over every stored plan of every window (each window weighted equally). */
function upkeepRow(plansByWindow) {
  const perWindow = Object.fromEntries(names.map(name => [name, plansByWindow[name].map(groups => upkeepOf(name, groups))]));
  return SHARES.map((share, si) => {
    const windowMean = key => meanOf(names.map(name => meanOf(perWindow[name].map(list => list[si][key]))));
    const sum = key => names.reduce((total, name) => total + perWindow[name].reduce((t, list) => t + list[si][key], 0), 0);
    return {
      share, tasked: windowMean('tasked'), all: windowMean('all'), noAttachTasked: windowMean('noAttachTasked'), noAttachAll: windowMean('noAttachAll'),
      changedTasked: windowMean('changedTasked'), looseAttachedShare: sum('looseAttached') / (sum('looseHidden') || 1), taskedAttachedShare: sum('taskedAttached') / (sum('taskedHidden') || 1)
    };
  });
}

const goldPlans = Object.fromEntries(names.map(name => {
  const order = [];
  const byTask = new Map();
  for (const tab of windows[name]) {
    if (!tab.task) continue;
    if (!byTask.has(tab.task)) {
      byTask.set(tab.task, []);
      order.push(tab.task);
    }
    byTask.get(tab.task).push(tab.id);
  }
  return [name, [order.map(task => ({ name: task, ids: byTask.get(task) }))]];
}));
const goldUpkeep = upkeepRow(goldPlans);
goldUpkeep.forEach((row, si) => {
  if (Math.abs(row.tasked - goldUpkeepRecorded[si]) > TOLERANCE) mismatches.push(`gold upkeep ${row.share}: replay ${row.tasked} against recorded ${goldUpkeepRecorded[si]}`);
});
if (mismatches.length) {
  console.error(`Replay differs from the recorded reports:\n${mismatches.join('\n')}`);
  process.exit(1);
}

const UPKEEP_ROWS = ['claude-haiku-5-5|plan|adaptive-low', 'claude-sonnet-5-5|plan|adaptive-low', 'claude-opus-5-5|plan|off'];
const upkeep = UPKEEP_ROWS.map(id => {
  const plans = Object.fromEntries(names.map(name => [name, appliedPlans[id][name].map(applied => applied.groups)]));
  const given = Object.fromEntries(names.map(name => [name, givenPlans[id][name]]));
  return {
    id, label: rowById[id].label, fresh: { tasked: rowById[id].twelve.appliedTasked, all: rowById[id].twelve.appliedAll }, shares: upkeepRow(plans),
    asGiven: upkeepRow(given).map(({ share, tasked, all }) => ({ share, tasked, all }))
  };
});

// --- against the independent review (p0-review at 578d2bd, its replay figures) -------------

const REVIEW = {
  recordedTasked12: { 'claude-haiku-5-5|labels|off': 0.4528, 'claude-haiku-5-5|plan|off': 0.6672, 'claude-haiku-5-5|plan|adaptive-low': 0.8318, 'claude-sonnet-5-5|plan|off': 0.8626, 'claude-sonnet-5-5|plan|adaptive-low': 0.8836, 'claude-opus-5-5|plan|off': 0.9174 },
  recordedTasked10: { 'claude-haiku-5-5|labels|off': 0.4314, 'claude-haiku-5-5|plan|off': 0.6348, 'claude-haiku-5-5|plan|adaptive-low': 0.8163, 'claude-sonnet-5-5|plan|off': 0.8451, 'claude-sonnet-5-5|plan|adaptive-low': 0.8734, 'claude-opus-5-5|plan|off': 0.9035 },
  asGivenAll12: { 'claude-haiku-5-5|labels|off': 0.4176, 'claude-haiku-5-5|plan|off': 0.5933, 'claude-haiku-5-5|plan|adaptive-low': 0.7664, 'claude-sonnet-5-5|plan|off': 0.7996, 'claude-sonnet-5-5|plan|adaptive-low': 0.8132, 'claude-opus-5-5|plan|off': 0.8603, rules: 0.224, gold: 0.439, 'cluster-4M': 0.391 },
  pooled4M: { tasked: 0.413, all: 0.370 },
  upkeepTasked: { 'claude-haiku-5-5|plan|adaptive-low': [0.792, 0.748, 0.702, 0.598], 'claude-sonnet-5-5|plan|adaptive-low': [0.839, 0.790, 0.740, 0.630] }
};
const crossCheck = [];
const check = (item, review, mine, note = '') => crossCheck.push({ item, review, mine, diff: mine - review, note });
for (const row of rows) {
  if (REVIEW.recordedTasked12[row.id] !== undefined) check(`${row.label}: recorded tasked, 12`, REVIEW.recordedTasked12[row.id], row.twelve.recordedTasked);
  if (REVIEW.recordedTasked10[row.id] !== undefined) check(`${row.label}: recorded tasked, 10`, REVIEW.recordedTasked10[row.id], row.ten.recordedTasked);
  if (REVIEW.asGivenAll12[row.id] !== undefined) check(`${row.label}: all tabs as given, 12`, REVIEW.asGivenAll12[row.id], row.twelve.asGivenAll);
}
check('4M clusters pooled and capped: tasked', REVIEW.pooled4M.tasked, rowById['cluster-4M'].twelve.pooledTasked, 'unassigned tabs pooled as one real group');
check('4M clusters pooled and capped: all tabs', REVIEW.pooled4M.all, rowById['cluster-4M'].twelve.pooledAll, 'unassigned tabs pooled as one real group');
for (const plan of upkeep) {
  (REVIEW.upkeepTasked[plan.id] || []).forEach((value, si) => {
    check(`Upkeep, ${plan.label}, ${Math.round(SHARES[si] * 100)}%: applied stored plan`, value, plan.shares[si].tasked, 'Review Later members unassigned, cap applied');
    check(`Upkeep, ${plan.label}, ${Math.round(SHARES[si] * 100)}%: plan as given`, value, plan.asGiven[si].tasked, 'Review Later kept as a group that tabs can attach to');
  });
}

// --- output ----------------------------------------------------------------------------------

const result = deep({
  policy: {
    applied: 'Each tab in at most one group (first placement wins, unknown ids ignored). Omitted tabs and tabs in a group named "Review Later" (any case) are unassigned. At most ten groups, the Review Later pool counting as one when any tab is unassigned: the largest groups stay (ties by first appearance), the tabs of the rest are unassigned.',
    tasked: 'Pairwise F1 over pairs of tabs with a gold task; unassigned tabs are singletons.',
    all: 'Pairwise F1 over every tab; a tab without a gold task is a gold singleton; unassigned tabs are singletons.',
    recorded: 'As the original reports scored it: plan answers as given (first placement wins, omitted ids singletons, any number of folders), local clusters as the ten largest clusters of 2+ tabs, tasked tabs only.',
    tenWindows: `Every window except ${[...PROMPT_WINDOWS].join(' and ')}, which were used to draft the plan prompt.`,
    pooled: 'Sensitivity only: the applied result with all unassigned tabs pooled as one real group.'
  },
  windows: names,
  tenWindows: clean,
  rows: rows.map(({ id, label, kind, file, settings, twelve, ten, perWindow }) => ({ id, label, kind, file, settings, twelve, ten, perWindow })),
  validity,
  pairedHaiku: { rows: paired, ...pairedSummary },
  crossCheck,
  upkeep: {
    settings: upkeepSettings,
    settingsSource: 'eval/results/local.json upkeep.4M.heldOut.perWindow (chosen leave-one-window-out on gold upkeep)',
    goldRecordedProtocol: SHARES.map((share, si) => ({ share, tasked: goldUpkeepRecorded[si] })),
    gold: goldUpkeep,
    plans: upkeep
  }
});

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'rescore.json'), `${JSON.stringify(result, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'rescore.md'), markdown(result));
console.log(`wrote ${path.relative(process.cwd(), path.join(outDir, 'rescore.json'))} and rescore.md`);

function markdown(r) {
  const f = (value, digits = 3) => (Number.isFinite(value) ? value.toFixed(digits) : '-');
  const pct = value => (Number.isFinite(value) ? `${Math.round(value * 100)}%` : '-');
  const lines = [];
  lines.push('# Phase 0 results under one scoring policy', '');
  lines.push('Generated by `node eval/rescore.mjs <models dir>` from the fixtures, `results/local.json`, `results/ablation.json` and the recorded answers in `results/provider/full/`. No model was called. The policy lives in `eval/scoring.mjs`.', '');
  lines.push('## Policy', '');
  lines.push(`- Applied result: ${r.policy.applied}`);
  lines.push(`- Tasked: ${r.policy.tasked} All tabs: ${r.policy.all}`);
  lines.push(`- Recorded: ${r.policy.recorded}`);
  lines.push(`- Ten windows: ${r.policy.tenWindows} The plan prompt's example folder name is one of \`life\`'s gold groups, so those two windows are not clean for the model rows.`);
  lines.push('- Local rows: rules and gold categories are single fixed runs; the cluster rows use the settings chosen leave-one-window-out (title words: tau 0.02 in eleven folds, 0.03 in one; 4M: idf, wl 1, tau 0.2 in every fold). Model rows: mean over two recorded attempts per window.', '');

  lines.push('## Mean F1 by path', '');
  lines.push('| Path | Recorded tasked, 12 | Recorded tasked, 10 | Applied tasked, 12 | Applied tasked, 10 | Applied all tabs, 12 | Applied all tabs, 10 |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of r.rows) {
    lines.push(`| ${row.label} | ${f(row.twelve.recordedTasked, 4)} | ${f(row.ten.recordedTasked, 4)} | ${f(row.twelve.appliedTasked, 4)} | ${f(row.ten.appliedTasked, 4)} | ${f(row.twelve.appliedAll, 4)} | ${f(row.ten.appliedAll, 4)} |`);
  }
  lines.push('', 'Mean tabs unassigned per window by the applied result (left out, Review Later or cut by the cap): ' + r.rows.map(row => `${row.label} ${f(row.twelve.unassigned, 1)}`).join('; ') + '.');

  lines.push('', '## Raw validity of the model answers', '');
  lines.push('Runs are window attempts (12 windows, two each). The applied result above repairs these; this table reports what came back.', '');
  lines.push('| Path | Runs | With omitted ids | With duplicate ids | With unknown ids | Over ten folders | Most folders | Worst omission |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const v of r.validity) {
    const unknown = v.withInvalidLabels === null ? `${v.withUnknown}` : `${v.withUnknown} (invalid labels in ${v.withInvalidLabels})`;
    lines.push(`| ${v.label} | ${v.runs} | ${v.withOmitted} | ${v.overLimit === null ? 'n/a' : v.withDuplicates} | ${unknown} | ${v.overLimit === null ? 'n/a' : v.overLimit} | ${v.maxFolders ?? 'n/a'} | ${v.worstOmission.omitted} of ${v.worstOmission.tabs} (${v.worstOmission.window}) |`);
  }
  lines.push('', 'For the label row, an omitted id is a tab without a valid label; today\'s planner still places it.');

  const p = r.pairedHaiku;
  lines.push('', '## Paired Haiku comparison (applied, all tabs)', '');
  lines.push('Haiku labels through today\'s planner against the Haiku plan with thinking off, both from the recorded answers.', '');
  lines.push('| Window | Labels | Plan, thinking off | Difference |', '| --- | ---: | ---: | ---: |');
  for (const row of p.rows) lines.push(`| ${row.window}${PROMPT_WINDOWS.has(row.window) ? ' (prompt drafted here)' : ''} | ${f(row.labels)} | ${f(row.plan)} | ${row.plan - row.labels >= 0 ? '+' : ''}${f(row.plan - row.labels)} |`);
  lines.push('', `The plan is better on ${p.planBetter} of ${p.windows} windows (${p.planBetterTen} of ${r.tenWindows.length} excluding dev and life); means ${f(p.meanLabels)} and ${f(p.meanPlan)}.`);

  lines.push('', '## Upkeep from recorded plans', '');
  lines.push('Each recorded answer, applied, is the stored plan. With the hidden sets and seeds of `eval/local-upkeep.mjs` (20 seeds per share), the hidden tabs are removed from the stored groups and every hidden tab, with a gold task or not, goes through the attach step with the 4M held-out upkeep setting recorded for its window in `results/local.json`. The whole window is then scored against gold. The recorded plans had seen the tabs that are later hidden, so these figures are still optimistic.', '');
  lines.push('| Stored plan | Hidden | Whole window, tasked | Whole window, all tabs | No attach, tasked | No attach, all tabs | New-tab pairs, tasked | Loose hidden tabs attached | Fresh plan, tasked / all |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const row of [...r.upkeep.plans, { label: 'Gold groups (this protocol)', fresh: { tasked: 1, all: 1 }, shares: r.upkeep.gold }]) {
    row.shares.forEach(s => lines.push(`| ${row.label} | ${pct(s.share)} | ${f(s.tasked)} | ${f(s.all)} | ${f(s.noAttachTasked)} | ${f(s.noAttachAll)} | ${f(s.changedTasked)} | ${pct(s.looseAttachedShare)} | ${f(row.fresh.tasked)} / ${f(row.fresh.all)} |`));
  }
  lines.push('', `Gold-plan figure as \`results/local.json\` reports it (gold groups, only tasked hidden tabs attached, tasked score): ${r.upkeep.goldRecordedProtocol.map(s => `${pct(s.share)} ${f(s.tasked)}`).join(', ')}. The tasked whole-window score above reproduces it, because a loose tab does not enter tasked pairs. "New-tab pairs" counts only the tasked pairs that touch a hidden tab.`);

  lines.push('', '## Against the independent review', '');
  lines.push('The review of commit 578d2bd replayed the recorded answers independently. Its figures beside this script\'s, with the scoring each used.', '');
  lines.push('| Figure | Review | This script | Difference | Note |', '| --- | ---: | ---: | ---: | --- |');
  for (const c of r.crossCheck) lines.push(`| ${c.item} | ${f(c.review, 4)} | ${f(c.mine, 4)} | ${c.diff >= 0 ? '+' : ''}${f(c.diff, 4)} | ${c.note} |`);
  lines.push('', 'The review scored stored plans as given. Under the policy here a Review Later folder is not a group, so its members are unassigned and hidden tabs cannot attach to it; that moves Sonnet low upkeep by up to 0.006. Scored as given, this script reproduces the review\'s upkeep figures.');
  lines.push('');
  return lines.join('\n');
}
