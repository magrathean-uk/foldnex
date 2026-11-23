// Pilot probe, not product code. Compares the current planner with a
// static-embedding task layer on the two pilot windows.
//   node eval/probe.mjs <dir holding potion-base-8M, -4M, -2M>
// Each model dir needs model.safetensors and tokenizer.json from
// huggingface.co/minishlab/<model>.
import { performance } from 'node:perf_hooks';
import { accuracyOf, describe, fmt, goldLabels, loadModel, loadWindows, mean, quantise, score } from './lib.mjs';
import {
  f1Of, hintLabels, inferredLabels, keywordLabels, noisyLabels, planAssignment, semanticTasks, siteThenKeywordLabels
} from './lib-legacy.mjs';

const MODELS_DIR = process.argv[2] || process.env.FOLDNEX_MODELS;
if (!MODELS_DIR) {
  console.error('Usage: node eval/probe.mjs <dir holding potion-base-8M, -4M and -2M>');
  process.exit(2);
}

// The pilot is bound to its two windows so its numbers stay comparable.
const all = await loadWindows();
const windows = { dev: all.dev, life: all.life };
const names = Object.keys(windows);
const model8 = loadModel(MODELS_DIR, 'potion-base-8M');

console.log('== 1. Where labels come from (current planner, no other change) ==');
for (const name of names) {
  const tabs = windows[name];
  const sources = [
    ['A  rules only (offline today)', inferredLabels(tabs)],
    ['   static, category hints only', hintLabels(model8, tabs)],
    ['   static, keyword centroids', keywordLabels(model8, tabs)],
    ['   site table + keyword centroids', siteThenKeywordLabels(model8, tabs)],
    ['B  perfect labels', goldLabels(tabs)]
  ];
  console.log(`${name}: ${tabs.length} tabs, ${new Set(tabs.map(tab => tab.task).filter(Boolean)).size} gold tasks`);
  for (const [label, labels] of sources) {
    const result = planAssignment(tabs, labels);
    console.log(`  ${label.padEnd(34)} labels right ${String(accuracyOf(labels, tabs)).padStart(2)}/${tabs.length}   ${fmt(score(result.assignment, tabs))}`);
    if (label.startsWith('B')) console.log(describe(result.groups, tabs));
  }
}

console.log('\n== 2. How accurate must labels be? (planner only, random label errors, mean of 20 seeds) ==');
for (const accuracy of [1, 0.9, 0.8, 0.7, 0.6]) {
  const row = names.map(name => mean(Array.from({ length: 20 }, (_, seed) => f1Of(windows[name], noisyLabels(windows[name], accuracy, seed + 1)))));
  console.log(`  labels ${Math.round(accuracy * 100)}% right:  F1 dev ${row[0].toFixed(2)}  life ${row[1].toFixed(2)}`);
}

console.log('\n== 3. Semantic task layer on top (F1; perfect labels | 85% labels, 10 seeds | site+keyword labels) ==');
for (const base of [{ wl: 0 }, { wl: 0.5 }, { wl: 0.5, idf: true }]) {
  console.log(`  config ${JSON.stringify(base)}   columns: dev perfect, life perfect | dev 85%, life 85% | dev kw, life kw | tasks dev, life`);
  for (const tau of [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6]) {
    const cells = [];
    const counts = [];
    for (const kind of ['perfect', 'noisy', 'kw']) {
      for (const name of names) {
        const tabs = windows[name];
        const tasks = semanticTasks(model8, tabs, { ...base, tau });
        if (kind === 'perfect') {
          cells.push(f1Of(tabs, goldLabels(tabs), tasks));
          counts.push(tasks.length);
        } else if (kind === 'noisy') {
          cells.push(mean(Array.from({ length: 10 }, (_, seed) => f1Of(tabs, noisyLabels(tabs, 0.85, seed + 1), tasks))));
        } else {
          cells.push(f1Of(tabs, siteThenKeywordLabels(model8, tabs), tasks));
        }
      }
    }
    const f = cells.map(value => value.toFixed(2));
    console.log(`    tau ${tau.toFixed(2)}:  ${f[0]} ${f[1]} | ${f[2]} ${f[3]} | ${f[4]} ${f[5]} | ${counts[0]} ${counts[1]}`);
  }
}
for (const name of names) {
  const tabs = windows[name];
  const result = planAssignment(tabs, goldLabels(tabs), semanticTasks(model8, tabs, { wl: 0.5, tau: 0.35 }));
  console.log(`  ${name}, perfect labels + tasks at wl 0.5 tau 0.35:`);
  console.log(describe(result.groups, tabs));
}

console.log('\n== 4. Model size and int8 (keyword-centroid labels right; F1 perfect labels + tasks at wl 0.5 tau 0.35) ==');
const candidates = [model8, quantise(model8, false), quantise(model8, true)];
for (const name of ['potion-base-4M', 'potion-base-2M']) {
  const model = loadModel(MODELS_DIR, name);
  candidates.push(model, quantise(model, true));
}
for (const model of candidates) {
  const cells = names.map(name => {
    const tabs = windows[name];
    const right = accuracyOf(siteThenKeywordLabels(model, tabs), tabs);
    const f1 = f1Of(tabs, goldLabels(tabs), semanticTasks(model, tabs, { wl: 0.5, tau: 0.35 }));
    return `${name} ${right}/${tabs.length} F1 ${f1.toFixed(2)}`;
  });
  console.log(`  ${model.name.padEnd(26)} dim ${String(model.dim).padEnd(4)} ${cells.join('   ')}`);
}

console.log('\n== 5. Time for one window (embed + label + affinity + cluster), median of 20 ==');
for (const name of names) {
  const tabs = windows[name];
  const times = [];
  for (let run = 0; run < 20; run++) {
    const startedAt = performance.now();
    siteThenKeywordLabels(model8, tabs);
    semanticTasks(model8, tabs, { wl: 0.5, tau: 0.35 });
    times.push(performance.now() - startedAt);
  }
  times.sort((a, b) => a - b);
  console.log(`  ${name}: ${times[10].toFixed(1)} ms for ${tabs.length} tabs`);
}
