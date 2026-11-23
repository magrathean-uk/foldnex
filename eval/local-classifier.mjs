// Local category classifier for the evaluation: multinomial logistic
// regression in plain JavaScript over [title vector, URL-word vector] from a
// static table. Seeded mini-batch Adam, L2 on the weights. Not product code.
import fs from 'node:fs';
import { CATEGORY_KEYS } from './frozen.mjs';
import { embed, mulberry32, urlWords } from './lib.mjs';

export const CLASSES = CATEGORY_KEYS;
const CLASS_INDEX = new Map(CLASSES.map((key, index) => [key, index]));

/** Rows {title, url, cat} of a JSONL file; rows with an unknown category are dropped. */
export function loadTitleSet(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim())
    .map(line => JSON.parse(line))
    .filter(row => typeof row.title === 'string' && CLASS_INDEX.has(row.cat));
}

export const classIndex = key => CLASS_INDEX.get(key);

/** Feature rows: title vector then URL-word vector, both unit length (zero when empty). */
export function features(model, items) {
  const titles = embed(model, items.map(item => [item.title, '']));
  const urls = embed(model, items.map(item => [urlWords(item.url), '']));
  const width = 2 * model.dim;
  const X = new Float64Array(items.length * width);
  items.forEach((_, row) => {
    X.set(titles[row], row * width);
    X.set(urls[row], row * width + model.dim);
  });
  return { X, width, count: items.length };
}

function shuffled(count, random) {
  const order = Array.from({ length: count }, (_, index) => index);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * Trains on rows `rows` of F (an index list). Features are standardised with
 * the training rows' mean and deviation. Loss: mean cross-entropy plus
 * lambda/2 * |W|^2.
 */
export function train(F, y, rows, { lambda = 1e-3, epochs = 30, batch = 64, lr = 0.01, seed = 1 } = {}) {
  const { X, width } = F;
  const C = CLASSES.length;
  const mean = new Float64Array(width);
  const std = new Float64Array(width);
  for (const r of rows) for (let d = 0; d < width; d++) mean[d] += X[r * width + d] / rows.length;
  for (const r of rows) for (let d = 0; d < width; d++) std[d] += (X[r * width + d] - mean[d]) ** 2 / rows.length;
  for (let d = 0; d < width; d++) std[d] = Math.sqrt(std[d]) || 1;
  const W = new Float64Array(C * width);
  const b = new Float64Array(C);
  const mW = new Float64Array(C * width);
  const vW = new Float64Array(C * width);
  const mB = new Float64Array(C);
  const vB = new Float64Array(C);
  const gW = new Float64Array(C * width);
  const gB = new Float64Array(C);
  const x = new Float64Array(width);
  const logits = new Float64Array(C);
  const random = mulberry32(seed);
  const beta1 = 0.9;
  const beta2 = 0.999;
  let t = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const order = shuffled(rows.length, random).map(index => rows[index]);
    for (let start = 0; start < order.length; start += batch) {
      const chunk = order.slice(start, start + batch);
      gW.fill(0);
      gB.fill(0);
      for (const r of chunk) {
        for (let d = 0; d < width; d++) x[d] = (X[r * width + d] - mean[d]) / std[d];
        let top = -Infinity;
        for (let c = 0; c < C; c++) {
          let z = b[c];
          const offset = c * width;
          for (let d = 0; d < width; d++) z += W[offset + d] * x[d];
          logits[c] = z;
          if (z > top) top = z;
        }
        let sum = 0;
        for (let c = 0; c < C; c++) sum += (logits[c] = Math.exp(logits[c] - top));
        for (let c = 0; c < C; c++) {
          const g = logits[c] / sum - (c === y[r] ? 1 : 0);
          if (g === 0) continue;
          gB[c] += g;
          const offset = c * width;
          for (let d = 0; d < width; d++) gW[offset + d] += g * x[d];
        }
      }
      t++;
      const scale = 1 / chunk.length;
      const c1 = 1 - beta1 ** t;
      const c2 = 1 - beta2 ** t;
      for (let k = 0; k < W.length; k++) {
        const g = gW[k] * scale + lambda * W[k];
        mW[k] = beta1 * mW[k] + (1 - beta1) * g;
        vW[k] = beta2 * vW[k] + (1 - beta2) * g * g;
        W[k] -= (lr * (mW[k] / c1)) / (Math.sqrt(vW[k] / c2) + 1e-8);
      }
      for (let c = 0; c < C; c++) {
        const g = gB[c] * scale;
        mB[c] = beta1 * mB[c] + (1 - beta1) * g;
        vB[c] = beta2 * vB[c] + (1 - beta2) * g * g;
        b[c] -= (lr * (mB[c] / c1)) / (Math.sqrt(vB[c] / c2) + 1e-8);
      }
    }
  }
  return { W, b, mean, std, width, lambda };
}

/** Class probabilities for every row of F: array of Float64Array(C). */
export function predict(clf, F) {
  const { W, b, mean, std, width } = clf;
  const C = CLASSES.length;
  const out = [];
  const x = new Float64Array(width);
  for (let r = 0; r < F.count; r++) {
    for (let d = 0; d < width; d++) x[d] = (F.X[r * width + d] - mean[d]) / std[d];
    const p = new Float64Array(C);
    let top = -Infinity;
    for (let c = 0; c < C; c++) {
      let z = b[c];
      for (let d = 0; d < width; d++) z += W[c * width + d] * x[d];
      p[c] = z;
      if (z > top) top = z;
    }
    let sum = 0;
    for (let c = 0; c < C; c++) sum += (p[c] = Math.exp(p[c] - top));
    for (let c = 0; c < C; c++) p[c] /= sum;
    out.push(p);
  }
  return out;
}

export const argmax = p => {
  let best = 0;
  for (let c = 1; c < p.length; c++) if (p[c] > p[best]) best = c;
  return best;
};

/** Seeded 80/20 split of row indices, stratified by category. */
export function randomSplit(rows, seed) {
  const random = mulberry32(seed);
  const train = [];
  const test = [];
  const byClass = new Map();
  rows.forEach((row, index) => {
    if (!byClass.has(row.cat)) byClass.set(row.cat, []);
    byClass.get(row.cat).push(index);
  });
  for (const key of CLASSES) {
    const list = byClass.get(key) || [];
    const order = shuffled(list.length, random).map(i => list[i]);
    const cut = Math.round(order.length * 0.2);
    test.push(...order.slice(0, cut));
    train.push(...order.slice(cut));
  }
  return { train: train.sort((a, b) => a - b), test: test.sort((a, b) => a - b) };
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Seeded split by site: whole hosts go to the test side until it holds 20% of rows. */
export function siteSplit(rows, seed) {
  const byHost = new Map();
  rows.forEach((row, index) => {
    const host = hostOf(row.url);
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(index);
  });
  const hosts = [...byHost.keys()].sort();
  const order = shuffled(hosts.length, mulberry32(seed)).map(i => hosts[i]);
  const test = [];
  const train = [];
  for (const host of order) (test.length < 0.2 * rows.length ? test : train).push(...byHost.get(host));
  return { train: train.sort((a, b) => a - b), test: test.sort((a, b) => a - b) };
}

export function accuracy(probabilities, labels, rows) {
  let right = 0;
  for (const r of rows) if (argmax(probabilities[r]) === labels[r]) right++;
  return right / (rows.length || 1);
}
