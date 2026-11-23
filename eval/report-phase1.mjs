// Phase 1 report: scores a directory of recordings under the one scoring policy (eval/scoring.mjs).
// No model call, no network. Not product code.
//   node eval/report-phase1.mjs <provider dir> [--out <dir>] [--compare <rescore.json>]
//   [--bar-f1 0.75] [--bar-p90-ms 6000] [--bar-max-tabs 66]
// Reads every run file (*.json with units) in <provider dir>: the matrix of run-provider.mjs --matrix,
// run-engine.mjs recordings and the Phase 0 files. Writes report.md and report.json to --out (default <dir>).
// --compare checks the model rows against a rescore.json (exit 1 above 5e-5).
import fs from 'node:fs';
import path from 'node:path';
import { loadWindows } from './lib.mjs';
import { applyGroups, pairF1, planGroupsOf, planValidity } from './scoring.mjs';
import { PLAN_EXAMPLE_NAME } from './phase1-lib.mjs';

const PROMPT_WINDOWS = new Set(['dev', 'life']); // drafted the pilot prompt; the pilot example name was a gold group of life
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv.splice(index, 2)[1] : fallback;
};
const outFlag = flag('--out', null);
const compareFile = flag('--compare', null);
const BAR = { f1: Number(flag('--bar-f1', 0.75)), p90Ms: Number(flag('--bar-p90-ms', 6000)), maxTabs: Number(flag('--bar-max-tabs', 66)) };
const dir = argv[0];
if (!dir) {
  console.error('Usage: node eval/report-phase1.mjs <provider dir> [--out <dir>] [--compare <rescore.json>] [--bar-f1 0.75] [--bar-p90-ms 6000] [--bar-max-tabs 66]');
  process.exit(2);
}
const outDir = outFlag || dir;

const mean = values => values.reduce((a, b) => a + b, 0) / (values.length || 1);
const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
};
const round = value => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : value);
const f4 = value => (value === null || value === undefined || Number.isNaN(value) ? '-' : value.toFixed(4));
const secs = ms => (ms === null || ms === undefined ? '-' : `${(ms / 1000).toFixed(2)} s`);
const usd = value => (value === null || value === undefined ? 'n/a' : `$${value.toFixed(5)}`);

const windows = await loadWindows();
const names = Object.keys(windows).sort();
const clean = names.filter(name => !PROMPT_WINDOWS.has(name));

// Three bands from the fixture sizes: sorted by size, split into thirds.
const bySize = [...names].sort((a, b) => windows[a].length - windows[b].length || a.localeCompare(b));
const bandOf = new Map(bySize.map((name, index) => [name, Math.floor((index * 3) / bySize.length)]));
const bands = [0, 1, 2].map(band => {
  const members = bySize.filter(name => bandOf.get(name) === band);
  const sizes = members.map(name => windows[name].length);
  return { band, name: ['small', 'middle', 'large'][band], windows: members, min: Math.min(...sizes), max: Math.max(...sizes) };
});

// --- read recordings -------------------------------------------------------------------------

const files = fs.readdirSync(dir).filter(name => name.endsWith('.json') && name !== 'report.json').sort();
const runs = [];
for (const file of files) {
  const run = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  if (Array.isArray(run.units)) runs.push({ file, ...run });
}
if (!runs.length) {
  console.error(`No recordings in ${dir}`);
  process.exit(2);
}

const settingId = run => [run.engine || run.model, run.engine ? run.model : null, run.mode, `${run.thinking}${run.effort ? `-${run.effort}` : ''}`, run.priority ? `priority-${run.priority}` : null].filter(Boolean).join('|');
const settingLabel = run => {
  if (run.engine) {
    const parts = [`${run.engine} ${run.model}`];
    if (run.effort) parts.push(`effort ${run.effort}`);
    if (run.priority) parts.push(`priority ${run.priority}`);
    return parts.join(', ');
  }
  const who = run.model.replace('claude-', '').replace(/-5-5$/, '').replace(/^./, c => c.toUpperCase());
  if (run.mode === 'labels') return `${who} labels`;
  if (!run.effort && run.effort_sent) return `${who} plan, effort ${run.effort_sent} (thinking omitted)`;
  return `${who} plan, ${run.effort ? `thinking ${run.thinking} / effort ${run.effort}` : `thinking ${run.thinking}`}`;
};

const groupsOfRun = new Map();
for (const run of runs) {
  const id = settingId(run);
  if (!groupsOfRun.has(id)) groupsOfRun.set(id, { id, label: settingLabel(run), runs: [] });
  groupsOfRun.get(id).runs.push(run);
}
const ORDER = ['claude-haiku-5-5|labels|off', 'claude-haiku-5-5|plan|off', 'claude-haiku-5-5|plan|adaptive-low', 'claude-sonnet-5-5|plan|off', 'claude-sonnet-5-5|plan|adaptive-low', 'claude-opus-5-5|plan|off'];
const orderOf = id => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);
const settings = [...groupsOfRun.values()].sort((a, b) => orderOf(a.id) - orderOf(b.id) || a.label.localeCompare(b.label));

// Label recordings (Phase 0) are replayed through the per-tab label pipeline, removed in Phase 4. Only a
// directory holding such a run needs it; without it the script stops with the legacy message.
const { cloudLabelBatchSize, parseLabelResponse, planGroups } = runs.some(run => run.mode === 'labels') ? await import('./legacy-labels.mjs') : {};

// --- score ------------------------------------------------------------------------------------

/** Groups [{name, ids}] a unit's answer stands for, and the raw validity of that answer. */
function readUnit(run, unit, tabs) {
  if (run.mode === 'labels') {
    if (unit.failed || !Array.isArray(unit.answer)) return { groups: [], validity: null };
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
    const plan = planGroups(tabs, byId, { locked: [] });
    return {
      groups: plan.groups.map(group => ({ name: group.name, ids: group.tabIds })),
      validity: { omitted: tabs.length - byId.size, duplicates: 0, unknown, invalidLabels: invalid, folders: null, overLimit: false }
    };
  }
  if (unit.failed || !unit.answer) return { groups: [], validity: null };
  return { groups: planGroupsOf(unit.answer, tabs), validity: planValidity(unit.answer, tabs) };
}

/** Pairwise F1 of assignment b against a over all tabs; unassigned tabs are singletons in both. */
function agree(a, b, tabs) {
  const label = (assignment, tab) => (assignment.has(tab.id) ? `g${assignment.get(tab.id)}` : `u${tab.id}`);
  let tp = 0; let fp = 0; let fn = 0;
  for (let i = 0; i < tabs.length; i++) {
    for (let j = i + 1; j < tabs.length; j++) {
      const inA = label(a, tabs[i]) === label(a, tabs[j]);
      const inB = label(b, tabs[i]) === label(b, tabs[j]);
      if (inA && inB) tp++; else if (inB) fp++; else if (inA) fn++;
    }
  }
  const p = tp / (tp + fp || 1); const r = tp / (tp + fn || 1);
  return (2 * p * r) / (p + r || 1);
}

const rows = [];
for (const setting of settings) {
  const perWindowUnits = Object.fromEntries(names.map(name => [name, []]));
  const validity = [];
  const failures = [];
  const latencies = [];
  const costs = [];
  const inputs = [];
  const outputs = [];
  let stub = false;
  let pilot = false;
  for (const run of setting.runs) {
    stub = stub || Boolean(run.stub);
    pilot = pilot || !run.plan_example_name;
    if (run.mode === 'plan' && run.plan_example_name && run.plan_example_name !== PLAN_EXAMPLE_NAME) pilot = true;
    for (const unit of run.units) {
      const tabs = windows[unit.window];
      if (!tabs) continue; // a window no longer in the fixtures
      const { groups, validity: check } = readUnit(run, unit, tabs);
      const applied = applyGroups(groups, tabs);
      const scored = {
        window: unit.window, repeat: unit.repeat, failed: Boolean(unit.failed),
        appliedTasked: pairF1(applied.assignment, tabs, 'tasked').f1,
        appliedAll: pairF1(applied.assignment, tabs, 'all').f1,
        unassigned: applied.unassigned.length, applied, wall_ms: unit.wall_ms
      };
      perWindowUnits[unit.window].push(scored);
      if (check) validity.push({ window: unit.window, tabs: tabs.length, ...check });
      if (unit.failed) {
        failures.push({ window: unit.window, repeat: unit.repeat, error: String(unit.requests?.[0]?.error || 'no valid answer').slice(0, 160) });
      } else {
        latencies.push({ window: unit.window, ms: unit.wall_ms });
        if (typeof unit.cost_usd === 'number') costs.push(unit.cost_usd);
      }
      if (typeof unit.input_tokens === 'number') inputs.push(unit.input_tokens);
      if (typeof unit.output_tokens === 'number') outputs.push(unit.output_tokens);
    }
  }
  const covered = names.filter(name => perWindowUnits[name].length);
  const perWindow = Object.fromEntries(covered.map(name => {
    const units = perWindowUnits[name];
    return [name, { units: units.length, appliedTasked: mean(units.map(u => u.appliedTasked)), appliedAll: mean(units.map(u => u.appliedAll)), unassigned: mean(units.map(u => u.unassigned)) }];
  }));
  const over = (list, key) => mean(list.filter(name => perWindow[name]).map(name => perWindow[name][key]));
  const coveredClean = clean.filter(name => perWindow[name]);

  // Agreement between repeats of a window, on applied results.
  const pairs = [];
  for (const name of covered) {
    const ok = perWindowUnits[name].filter(u => !u.failed);
    for (let i = 0; i < ok.length; i++) for (let j = i + 1; j < ok.length; j++) pairs.push(agree(ok[i].applied.assignment, ok[j].applied.assignment, windows[name]));
  }

  const latencyStats = list => ({ n: list.length, p50: quantile(list.map(x => x.ms), 0.5), p90: quantile(list.map(x => x.ms), 0.9) });
  const bandStats = bands.map(band => ({ name: band.name, ...latencyStats(latencies.filter(x => bandOf.get(x.window) === band.band)) }));

  // The bar: all tabs over every window, and p90 inside the budget on the windows up to maxTabs.
  // A failed request counts as over budget.
  const barWindows = names.filter(name => windows[name].length <= BAR.maxTabs);
  const barLatencies = [];
  for (const name of barWindows) for (const u of perWindowUnits[name]) barLatencies.push(u.failed ? Infinity : u.wall_ms);
  const barP90 = quantile(barLatencies, 0.9);
  const allTwelve = over(names, 'appliedAll');
  let bar;
  if (stub) bar = { status: 'n/a', reason: 'stub recording, not a measurement' };
  else if (setting.runs[0].mode === 'labels') bar = { status: 'n/a', reason: 'label requests, not a plan' };
  else if (pilot) bar = { status: 'n/a', reason: `recorded with the pilot wording, not "${PLAN_EXAMPLE_NAME}"` };
  else if (covered.length < names.length) bar = { status: 'n/a', reason: `partial: ${covered.length} of ${names.length} windows` };
  else {
    const f1Ok = allTwelve >= BAR.f1;
    const latencyOk = barP90 !== null && barP90 <= BAR.p90Ms;
    bar = { status: f1Ok && latencyOk ? 'meets' : 'misses', f1Ok, latencyOk };
  }

  rows.push({
    id: setting.id, label: setting.label, files: setting.runs.map(run => run.file), stub, pilotWording: pilot,
    windows: covered.length, units: Object.values(perWindowUnits).flat().length,
    twelve: { appliedTasked: over(names, 'appliedTasked'), appliedAll: allTwelve, unassigned: over(names, 'unassigned') },
    ten: { appliedTasked: over(clean, 'appliedTasked'), appliedAll: over(clean, 'appliedAll'), windows: coveredClean.length },
    perWindow, validity, failures,
    latency: { overall: latencyStats(latencies), bands: bandStats, bar: { maxTabs: BAR.maxTabs, p90: barP90 === Infinity ? null : barP90, failedCounted: barLatencies.includes(Infinity) } },
    cost: {
      meanUsd: costs.length ? mean(costs) : null,
      meanInputTokens: inputs.length ? mean(inputs) : null, meanOutputTokens: outputs.length ? mean(outputs) : null
    },
    agreement: { mean: pairs.length ? mean(pairs) : null, pairs: pairs.length },
    bar
  });
}

// --- compare with rescore.json -------------------------------------------------------------

const comparison = [];
if (compareFile) {
  const rescore = JSON.parse(fs.readFileSync(compareFile, 'utf8'));
  for (const row of rows) {
    const other = rescore.rows.find(item => item.kind === 'provider' && item.id === row.id);
    if (!other) continue;
    for (const [population, mine, theirs] of [
      ['tasked, 12', row.twelve.appliedTasked, other.twelve.appliedTasked],
      ['tasked, 10', row.ten.appliedTasked, other.ten.appliedTasked],
      ['all tabs, 12', row.twelve.appliedAll, other.twelve.appliedAll],
      ['all tabs, 10', row.ten.appliedAll, other.ten.appliedAll]
    ]) comparison.push({ id: row.id, label: row.label, population, mine: round(mine), rescore: theirs, differs: Math.abs(round(mine) - theirs) > 5e-5 });
  }
}

// --- write ------------------------------------------------------------------------------------

const rawCount = (row, key) => row.validity.filter(check => check[key] > 0).length;
const lines = [
  '# Phase 1 report',
  '',
  `Generated by \`node eval/report-phase1.mjs ${path.relative(process.cwd(), dir) || '.'}\` from ${runs.length} recording file(s). No model was called. The policy is \`eval/scoring.mjs\` (the applied result; see \`eval/README.md\`).`,
  '',
  `**Sample.** Twelve synthetic windows (${names.reduce((sum, name) => sum + windows[name].length, 0)} tabs written for this evaluation, ${Math.min(...names.map(n => windows[n].length))} to ${Math.max(...names.map(n => windows[n].length))} tabs each), usually two repeats per setting. It separates settings that are far apart; it does not rank settings within a few points of each other, and it says nothing about real browsing.`,
  '',
  `**Phase 1 bar.** Mean applied F1 on all tabs of at least ${BAR.f1} over the twelve windows, and p90 latency within ${BAR.p90Ms / 1000} seconds on the windows of up to ${BAR.maxTabs} tabs (the small and middle bands below; a failed request counts as over budget). Recordings made with the pilot wording or a stub, and partial runs, are not judged.`,
  `Ten windows means all but ${[...PROMPT_WINDOWS].join(' and ')}, the pair that drafted the pilot prompt; the current prompt's example name ("${PLAN_EXAMPLE_NAME}") is checked by \`eval/check.mjs\` against every gold task name and tab title.`,
  '',
  '## Mean F1 and the bar',
  '',
  '| Setting | Windows | Applied tasked, 12 | Applied tasked, 10 | Applied all tabs, 12 | Applied all tabs, 10 | p90, up to ' + BAR.maxTabs + ' tabs | Bar |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |'
];
for (const row of rows) {
  const verdict = row.bar.status === 'n/a' ? `n/a (${row.bar.reason})` : row.bar.status === 'meets' ? 'meets' : `misses (${[!row.bar.f1Ok && `F1 under ${BAR.f1}`, !row.bar.latencyOk && 'p90 over budget'].filter(Boolean).join(', ')})`;
  lines.push(`| ${row.label} | ${row.windows} | ${f4(row.twelve.appliedTasked)} | ${f4(row.ten.appliedTasked)} | ${f4(row.twelve.appliedAll)} | ${f4(row.ten.appliedAll)} | ${row.latency.bar.failedCounted ? 'over (a failure)' : secs(row.latency.bar.p90)} | ${verdict} |`);
}
lines.push('', 'A setting that covers fewer than twelve windows has its means over the windows it covers.');

lines.push('', '## Raw validity of the answers', '', 'What came back, before the applied result repairs it. Counts are runs (a window attempt).', '',
  '| Setting | Runs | With omitted ids | With duplicate ids | With unknown ids | Over ten folders | Most folders | Worst omission |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
for (const row of rows) {
  const isLabels = row.id.includes('|labels|');
  const worst = row.validity.reduce((top, check) => (!top || check.omitted > top.omitted ? check : top), null);
  lines.push(`| ${row.label} | ${row.validity.length} | ${rawCount(row, 'omitted')} | ${isLabels ? 'n/a' : rawCount(row, 'duplicates')} | ${rawCount(row, 'unknown')}${isLabels ? ` (invalid labels in ${rawCount(row, 'invalidLabels')})` : ''} | ${isLabels ? 'n/a' : row.validity.filter(c => c.overLimit).length} | ${isLabels ? 'n/a' : Math.max(0, ...row.validity.map(c => c.folders))} | ${worst ? `${worst.omitted} of ${worst.tabs} (${worst.window})` : '-'} |`);
}

lines.push('', '## Latency', '', `Wall time of one request (failures excluded). Bands come from the fixture sizes, twelve windows in three equal parts: ${bands.map(b => `${b.name} ${b.min} to ${b.max} tabs (${b.windows.join(', ')})`).join('; ')}.`, '',
  `| Setting | p50 | p90 | ${bands.map(b => `${b.name} p50 / p90`).join(' | ')} |`, `| --- | ---: | ---: | ${bands.map(() => '---:').join(' | ')} |`);
for (const row of rows) {
  lines.push(`| ${row.label} | ${secs(row.latency.overall.p50)} | ${secs(row.latency.overall.p90)} | ${row.latency.bands.map(b => `${secs(b.p50)} / ${secs(b.p90)} (n ${b.n})`).join(' | ')} |`);
}

lines.push('', '## Cost, agreement and failures', '', 'Cost is the mean per request (one window). It is in USD only where the recording holds a price; otherwise read the tokens. Agreement is the pairwise F1 between the applied results of the two repeats of a window, over all tabs, averaged over windows.', '',
  '| Setting | Mean cost per window | Mean input tokens | Mean output tokens | Agreement between repeats | Failures |', '| --- | ---: | ---: | ---: | ---: | ---: |');
for (const row of rows) {
  lines.push(`| ${row.label} | ${usd(row.cost.meanUsd)} | ${row.cost.meanInputTokens === null ? '-' : Math.round(row.cost.meanInputTokens)} | ${row.cost.meanOutputTokens === null ? '-' : Math.round(row.cost.meanOutputTokens)} | ${row.agreement.mean === null ? '-' : `${f4(row.agreement.mean)} (${row.agreement.pairs} pairs)`} | ${row.failures.length} of ${row.units} |`);
}
const failed = rows.filter(row => row.failures.length);
if (failed.length) {
  lines.push('', 'Failed requests (scored as nothing grouped):', '');
  for (const row of failed) for (const failure of row.failures) lines.push(`- ${row.label}, ${failure.window} #${failure.repeat}: ${failure.error}`);
}
const stubbed = rows.filter(row => row.stub);
if (stubbed.length) lines.push('', `Stub recordings (no network, not a measurement): ${stubbed.map(row => row.label).join('; ')}.`);

lines.push('', '## Per window, applied all tabs', '', `| Window | Tabs | ${rows.map(row => row.label).join(' | ')} |`, `| --- | ---: | ${rows.map(() => '---:').join(' | ')} |`);
for (const name of names) lines.push(`| ${name} | ${windows[name].length} | ${rows.map(row => (row.perWindow[name] ? f4(row.perWindow[name].appliedAll) : '-')).join(' | ')} |`);
lines.push('');

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'report.md'), lines.join('\n'));
const deep = value => {
  if (Array.isArray(value)) return value.map(deep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'applied').map(([key, item]) => [key, deep(item)]));
  return round(value);
};
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(deep({
  bar: BAR, planExampleName: PLAN_EXAMPLE_NAME, windows: names.map(name => ({ name, tabs: windows[name].length, band: bands[bandOf.get(name)].name })), bands: bands.map(({ name, min, max, windows: members }) => ({ name, min, max, windows: members })), rows, comparison
}), null, 1));
console.log(`wrote ${path.join(outDir, 'report.md')} and report.json (${rows.length} setting(s))`);
for (const row of rows) console.log(`${row.label.padEnd(52)} all-tabs 12: ${f4(row.twelve.appliedAll)}  10: ${f4(row.ten.appliedAll)}  bar: ${row.bar.status}`);
if (compareFile) {
  const bad = comparison.filter(item => item.differs);
  console.log(`compared ${comparison.length} cells with ${compareFile}: ${bad.length} differ`);
  for (const item of bad) console.log(`  ${item.label} ${item.population}: ${item.mine} against ${item.rescore}`);
  if (bad.length || !comparison.length) process.exit(1);
}
