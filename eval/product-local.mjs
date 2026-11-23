// Scores the product's local engine (src/local-engine.js clusterTabs) on the
// twelve fixture windows under the one scoring policy (eval/scoring.mjs).
// Not product code.
//   node eval/product-local.mjs [models dir holding potion-base-4M] [--names] [--out <dir>]
// Title words only always; with a models directory also with vectors made by
// embed() (idf on, centring off, the int8 4M table, title plus URL words at
// 0.5). --names prints each window's local groups from planLocally (name,
// size, three sample titles). Writes product-local.json and .md only with --out.
import fs from 'node:fs';
import path from 'node:path';
import { clusterTabs, planLocally } from '../src/local-engine.js';
import { embed, loadModel, loadWindows, toInt8, urlWords } from './lib.mjs';
import { pairF1 } from './scoring.mjs';

const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
const outDir = outIndex >= 0 ? argv.splice(outIndex, 2)[1] : null;
const namesIndex = argv.indexOf('--names');
const showNames = namesIndex >= 0;
if (showNames) argv.splice(namesIndex, 1);
const MODELS_DIR = argv[0] || null;

const PROMPT_WINDOWS = new Set(['dev', 'life']); // used to draft the plan prompt
// eval/results/rescore.md, "Applied all tabs" and "Applied tasked", twelve and ten windows.
const PROTOTYPE = {
  words: { all12: 0.3351, all10: 0.3280, tasked12: 0.3524, tasked10: 0.3476 },
  vectors: { all12: 0.3896, all10: 0.3665, tasked12: 0.4192, tasked10: 0.3971 }
};

const windows = await loadWindows();
const names = Object.keys(windows).sort();
const clean = names.filter(name => !PROMPT_WINDOWS.has(name));
const meanOf = values => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
const round = value => Math.round(value * 1e4) / 1e4;

const model = MODELS_DIR ? toInt8(loadModel(MODELS_DIR, 'potion-base-4M')) : null;
function vectorsFor(tabs) {
  const rows = embed(model, tabs.map(tab => [tab.title, urlWords(tab.url)]), { idf: true, center: false, urlWeight: 0.5 });
  return new Map(tabs.map((tab, index) => [tab.id, Float32Array.from(rows[index])]));
}

function scoreRun(label, vectorsOf) {
  const perWindow = {};
  for (const name of names) {
    const tabs = windows[name];
    const vectors = vectorsOf ? vectorsOf(tabs) : null;
    const { groups, unassigned } = clusterTabs(tabs, { vectors });
    const assignment = new Map();
    groups.forEach((group, index) => group.tabIds.forEach(id => assignment.set(id, index)));
    perWindow[name] = {
      all: pairF1(assignment, tabs, 'all').f1,
      tasked: pairF1(assignment, tabs, 'tasked').f1,
      groups: groups.length,
      unassigned: unassigned.length
    };
  }
  const over = (list, key) => meanOf(list.map(name => perWindow[name][key]));
  return {
    label,
    all12: over(names, 'all'),
    all10: over(clean, 'all'),
    tasked12: over(names, 'tasked'),
    tasked10: over(clean, 'tasked'),
    unassigned12: over(names, 'unassigned'),
    perWindow
  };
}

const runs = { words: scoreRun('Title words only (tau 0.02)', null) };
if (model) runs.vectors = scoreRun('With the 4M table (cosine + 1 x words, tau 0.2)', vectorsFor);

const lines = [
  '| Local engine | All tabs, 12 | All tabs, 10 | Tasked, 12 | Tasked, 10 | Prototype all tabs, 12 | Prototype tasked, 12 | Unassigned per window |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
];
for (const [key, run] of Object.entries(runs)) {
  const proto = PROTOTYPE[key];
  lines.push(`| ${run.label} | ${run.all12.toFixed(4)} | ${run.all10.toFixed(4)} | ${run.tasked12.toFixed(4)} | ${run.tasked10.toFixed(4)} | ${proto.all12.toFixed(4)} | ${proto.tasked12.toFixed(4)} | ${run.unassigned12.toFixed(1)} |`);
}
lines.push('', '| Window | ' + Object.keys(runs).map(key => `${key} all / tasked`).join(' | ') + ' |', '| --- |' + Object.keys(runs).map(() => ' ---: |').join(''));
for (const name of names) {
  lines.push(`| ${name} | ` + Object.values(runs).map(run => `${run.perWindow[name].all.toFixed(3)} / ${run.perWindow[name].tasked.toFixed(3)}`).join(' | ') + ' |');
}
console.log(lines.join('\n'));

const nameLines = [];
if (showNames) {
  const key = model ? 'vectors' : 'words';
  nameLines.push('', `## Local group names (planLocally, ${key === 'vectors' ? 'with the 4M table' : 'title words only'})`);
  for (const name of names) {
    const tabs = windows[name];
    const byId = new Map(tabs.map(tab => [tab.id, tab]));
    const plan = planLocally(tabs, { tabsById: byId, vectors: model ? vectorsFor(tabs) : null });
    nameLines.push('', `### ${name} (${tabs.length} tabs)`);
    for (const group of plan.groups) {
      const samples = group.tabIds.slice(0, 3).map(id => JSON.stringify(byId.get(id).title.slice(0, 60))).join(', ');
      nameLines.push(`- ${group.name} [${group.tabIds.length}]: ${samples}`);
    }
  }
  console.log(nameLines.join('\n'));
}

if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const json = Object.fromEntries(Object.entries(runs).map(([key, run]) => [key, {
    ...run,
    all12: round(run.all12), all10: round(run.all10), tasked12: round(run.tasked12), tasked10: round(run.tasked10),
    unassigned12: round(run.unassigned12),
    perWindow: Object.fromEntries(Object.entries(run.perWindow).map(([name, row]) => [name, { ...row, all: round(row.all), tasked: round(row.tasked) }])),
    prototype: PROTOTYPE[key]
  }]));
  fs.writeFileSync(path.join(outDir, 'product-local.json'), `${JSON.stringify(json, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'product-local.md'), `# Product local engine on twelve windows\n\nGenerated by \`node eval/product-local.mjs${MODELS_DIR ? ' <models dir>' : ''}${showNames ? ' --names' : ''}\`.\n\n${lines.join('\n')}\n${nameLines.join('\n')}\n`);
  console.log(`\nWrote ${path.join(outDir, 'product-local.json')} and product-local.md`);
}
