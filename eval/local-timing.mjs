// Timing for the local pipeline on synthetic windows: embed, label with the
// classifier (keyword centroids when there is no title set), semantic tasks,
// planner. Cold runs in a fresh Node process each time and includes reading
// the table and converting it to int8; warm is the median of repeated calls in
// one process. Not product code.
//   node eval/local-timing.mjs --child <modelsDir> <model> <tabs> <spec.json>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { planGroups } from './legacy-labels.mjs';
import { CLASSES, argmax, features, predict } from './local-classifier.mjs';
import { dendrogram, cut, tasksFromClusters } from './local-cluster.mjs';
import { affinity, loadModel, loadWindowRows, syntheticWindow, toInt8 } from './lib.mjs';
import { inferredLabels, keywordLabels } from './lib-legacy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

export { syntheticWindow };

/** One full local plan: labels, tasks, planner. Returns the planner result. */
export function pipeline(model, clf, tabs, spec) {
  let labels;
  if (clf) {
    const probabilities = predict(clf, features(model, tabs));
    labels = new Map(tabs.map((tab, index) => [tab.id, CLASSES[argmax(probabilities[index])]]));
    for (const [id, value] of inferredLabels(tabs)) if (value.src === 'site') labels.set(id, value.c);
  } else {
    labels = keywordLabels(model, tabs);
  }
  const S = affinity(model, tabs, spec);
  const locked = tasksFromClusters(cut(dendrogram(S, tabs.length), tabs.length, spec.tau), tabs);
  return planGroups(tabs, labels, { locked });
}

function writeSpec(clf, spec) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'foldnex-timing-')), 'spec.json');
  const plain = clf && { ...clf, W: Array.from(clf.W), b: Array.from(clf.b), mean: Array.from(clf.mean), std: Array.from(clf.std) };
  fs.writeFileSync(file, JSON.stringify({ clf: plain, spec }));
  return file;
}

/** {sizes: {n: {coldMs, coldLoadMs, warmMs}}}; cold is the median of `coldRuns` (7) fresh processes. */
export async function measureTiming(modelsDir, modelName, clf, spec, { sizes = [60, 200, 500], coldRuns = 7, warmRuns = 20 } = {}) {
  const rows = Object.values(await loadWindowRows()).flat();
  const specFile = writeSpec(clf, spec);
  const model = toInt8(loadModel(modelsDir, modelName));
  const out = {};
  for (const n of sizes) {
    const cold = [];
    for (let run = 0; run < coldRuns; run++) {
      const text = execFileSync(process.execPath, [path.join(HERE, 'local-timing.mjs'), '--child', modelsDir, modelName, String(n), specFile], { encoding: 'utf8' });
      cold.push(JSON.parse(text));
    }
    const tabs = syntheticWindow(rows, n);
    for (let run = 0; run < 3; run++) pipeline(model, clf, tabs, spec);
    const warm = [];
    for (let run = 0; run < warmRuns; run++) {
      const startedAt = performance.now();
      pipeline(model, clf, tabs, spec);
      warm.push(performance.now() - startedAt);
    }
    out[n] = {
      coldMs: median(cold.map(row => row.loadMs + row.firstMs)),
      coldLoadMs: median(cold.map(row => row.loadMs)),
      coldFirstPlanMs: median(cold.map(row => row.firstMs)),
      warmMs: median(warm)
    };
  }
  fs.rmSync(path.dirname(specFile), { recursive: true, force: true });
  return out;
}

if (process.argv[2] === '--child') {
  const [modelsDir, modelName, n, specFile] = process.argv.slice(3);
  const { clf: plain, spec } = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  const rows = Object.values(await loadWindowRows()).flat();
  const tabs = syntheticWindow(rows, Number(n));
  const startedAt = performance.now();
  const model = toInt8(loadModel(modelsDir, modelName));
  const clf = plain && { ...plain, W: Float64Array.from(plain.W), b: Float64Array.from(plain.b), mean: Float64Array.from(plain.mean), std: Float64Array.from(plain.std) };
  const loadedAt = performance.now();
  pipeline(model, clf, tabs, spec);
  const doneAt = performance.now();
  process.stdout.write(JSON.stringify({ loadMs: loadedAt - startedAt, firstMs: doneAt - loadedAt }));
}
