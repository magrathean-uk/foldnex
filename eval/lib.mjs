// Shared helpers for the grouping evaluation. Not product code and not shipped.
// The static embedder here is the prototype for src/embedder.js.
// Nothing here imports the per-tab label pipeline (removed in Phase 4); the helpers that need it
// are in lib-legacy.mjs, behind legacy-labels.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { titleTokens } from '../src/planner.js';
import { pairF1 } from './scoring.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(HERE, 'fixtures');

// --- static embedder: WordPiece lookup + weighted mean ----------------------

export function loadModel(modelsDir, name) {
  const dir = `${modelsDir}/${name}`;
  const buf = fs.readFileSync(`${dir}/model.safetensors`);
  const headerLength = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.subarray(8, 8 + headerLength).toString('utf8'));
  const { shape: [rows, dim], data_offsets: [start, end] } = header.embeddings;
  const base = buf.byteOffset + 8 + headerLength + start;
  const matrix = new Float32Array(buf.buffer.slice(base, base + (end - start)));
  const tokenizer = JSON.parse(fs.readFileSync(`${dir}/tokenizer.json`, 'utf8'));
  return { name, rows, dim, matrix, vocab: new Map(Object.entries(tokenizer.model.vocab)) };
}

/** Same model with an int8 matrix: one global scale, or one scale per row. */
export function quantise(model, perRow) {
  const { rows, dim, matrix } = model;
  const q = new Float32Array(matrix.length);
  let globalMax = 0;
  for (const value of matrix) globalMax = Math.max(globalMax, Math.abs(value));
  for (let row = 0; row < rows; row++) {
    let max = globalMax;
    if (perRow) {
      max = 0;
      for (let d = 0; d < dim; d++) max = Math.max(max, Math.abs(matrix[row * dim + d]));
    }
    if (max === 0) continue;
    for (let d = 0; d < dim; d++) {
      q[row * dim + d] = Math.round(matrix[row * dim + d] / max * 127) * max / 127;
    }
  }
  return { ...model, name: `${model.name}/int8${perRow ? '-row' : ''}`, matrix: q };
}

/**
 * Real int8 storage, as the extension would ship it: one Int8Array and one
 * Float32 scale per row (max |value| / 127). embed() reads it directly.
 */
export function toInt8(model) {
  const { rows, dim, matrix } = model;
  const q = new Int8Array(rows * dim);
  const scales = new Float32Array(rows);
  for (let row = 0; row < rows; row++) {
    let max = 0;
    for (let d = 0; d < dim; d++) max = Math.max(max, Math.abs(matrix[row * dim + d]));
    if (max === 0) continue;
    scales[row] = max / 127;
    for (let d = 0; d < dim; d++) q[row * dim + d] = Math.round(matrix[row * dim + d] / max * 127);
  }
  return { name: `${model.name}/int8-row`, rows, dim, vocab: model.vocab, q, scales };
}

// BERT pre-tokenisation as tokenizer.json declares it (BertNormalizer with
// clean_text, handle_chinese_chars, lowercase; BertPreTokenizer): split on
// ASCII and Unicode punctuation and around each CJK ideograph (the BMP and
// supplementary ranges of BERT's _is_chinese_char).
export const SPLIT = /([!-\/:-@\[-`{-~\p{P}]|[㐀-䶿一-鿿豈-﫿\u{20000}-\u{2A6DF}\u{2A700}-\u{2B73F}\u{2B740}-\u{2B81F}\u{2B820}-\u{2CEAF}\u{2F800}-\u{2FA1F}])/u;

// clean_text deletes NUL, U+FFFD and every "other" character (Cc, Cf, Cn, Co,
// Cs) except tab, CR and LF. Deleting, not spacing, matters: a zero-width
// space or soft hyphen inside a word joins its halves.
const DROPPED = /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}�]/gu;

export function words(text) {
  // Same order as the Rust normaliser: clean, strip accents (NFD, drop Mn, no
  // recomposition), then lowercase one character at a time, so a word-final
  // capital sigma becomes σ, not the contextual ς that toLowerCase() gives.
  let clean = String(text || '').replace(DROPPED, '').normalize('NFD').replace(/\p{Mn}+/gu, '');
  clean = Array.from(clean, char => char.toLowerCase()).join('');
  const out = [];
  for (const chunk of clean.split(/\s+/u)) {
    for (const piece of chunk.split(SPLIT)) if (piece) out.push(piece);
  }
  return out;
}

export function tokenIds(model, text) {
  const ids = [];
  for (const word of words(text)) {
    // WordPiece counts and slices characters (code points), not UTF-16 units.
    const chars = Array.from(word);
    if (chars.length > 100) continue;
    const pieces = [];
    let start = 0;
    let matched = true;
    while (start < chars.length) {
      let end = chars.length;
      let id;
      while (start < end) {
        id = model.vocab.get((start > 0 ? '##' : '') + chars.slice(start, end).join(''));
        if (id !== undefined) break;
        end--;
      }
      if (id === undefined) {
        matched = false;
        break;
      }
      pieces.push(id);
      start = end;
    }
    // A word with no match is [UNK], which model2vec leaves out.
    if (matched) ids.push(...pieces);
  }
  return ids;
}

export const URL_NOISE = new Set(['www', 'com', 'co', 'uk', 'org', 'net', 'io', 'html', 'php', 'htm', 'en', 'gb', 'index', 'docs', 'app']);

export function urlWords(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname} ${parsed.pathname}`.toLowerCase().split(/[^a-z0-9]+/)
      .filter(word => word.length > 1 && word.length < 25 && !URL_NOISE.has(word) && !/\d{3,}/.test(word))
      .slice(0, 8)
      .join(' ');
  } catch {
    return '';
  }
}

export function unit(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < vector.length; d++) vector[d] /= norm;
  return vector;
}

/** One unit vector per text pair [title, url words]; idf and centring work across the window. */
export function embed(model, pairs, { idf = false, center = false, urlWeight = 0.5 } = {}) {
  const lists = pairs.map(([title, url]) => ({ title: tokenIds(model, title), url: tokenIds(model, url) }));
  const df = new Map();
  for (const list of lists) {
    for (const id of new Set([...list.title, ...list.url])) df.set(id, (df.get(id) || 0) + 1);
  }
  const weight = id => (idf ? Math.log((pairs.length + 1) / (df.get(id) + 0.5)) : 1);
  const vectors = lists.map(list => {
    const vector = new Float64Array(model.dim);
    const add = (ids, scale) => {
      for (const id of ids) {
        const w = scale * weight(id);
        const offset = id * model.dim;
        if (model.q) {
          const ws = w * model.scales[id];
          for (let d = 0; d < model.dim; d++) vector[d] += ws * model.q[offset + d];
        } else {
          for (let d = 0; d < model.dim; d++) vector[d] += w * model.matrix[offset + d];
        }
      }
    };
    add(list.title, 1);
    add(list.url, urlWeight);
    return unit(vector);
  });
  if (center) {
    const mean = new Float64Array(model.dim);
    for (const vector of vectors) for (let d = 0; d < model.dim; d++) mean[d] += vector[d] / vectors.length;
    for (const vector of vectors) {
      for (let d = 0; d < model.dim; d++) vector[d] -= mean[d];
      unit(vector);
    }
  }
  return vectors;
}

export function cosineMatrix(vectors) {
  const n = vectors.length;
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let dot = 0;
      for (let d = 0; d < vectors[i].length; d++) dot += vectors[i][d] * vectors[j][d];
      out[i * n + j] = dot;
      out[j * n + i] = dot;
    }
  }
  return out;
}

/** Idf-weighted overlap of the planner's own title tokens (the exact-word channel). */
export function sparseMatrix(tabs) {
  const n = tabs.length;
  const sets = tabs.map(tab => titleTokens(tab));
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

/** Average-linkage clustering: merge while the best pair is at least tau, or down to k clusters. */
export function agglomerate(S, n, { tau = -Infinity, k = 1 } = {}) {
  const clusters = Array.from({ length: n }, (_, index) => [index]);
  while (clusters.length > k) {
    let best = -Infinity;
    let pair = null;
    for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        let sum = 0;
        for (const i of clusters[a]) for (const j of clusters[b]) sum += S[i * n + j];
        const average = sum / (clusters[a].length * clusters[b].length);
        if (average > best) {
          best = average;
          pair = [a, b];
        }
      }
    }
    if (!pair || best < tau) break;
    clusters[pair[0]] = clusters[pair[0]].concat(clusters[pair[1]]);
    clusters.splice(pair[1], 1);
  }
  return clusters;
}

// --- windows, labels, scoring ----------------------------------------------

export function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tabs in a seeded random strip order, so adjacency carries no signal. */
export function buildWindow(rows, seed) {
  const random = mulberry32(seed);
  const order = rows.map((row, index) => ({ row, key: random(), index })).sort((a, b) => a.key - b.key);
  return order.map(({ row }, position) => ({
    id: position + 1,
    index: position,
    title: row[0],
    url: row[1],
    cat: row[2],
    task: row[3],
    windowId: 1,
    pinned: false
  }));
}

/** n tabs from every fixture row in turn; repeats get a distinct URL. */
export function syntheticWindow(allRows, n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const [title, url, cat, task] = allRows[i % allRows.length];
    const copy = Math.floor(i / allRows.length);
    rows.push(copy ? [title, `${url}${url.includes('?') ? '&' : '?'}copy=${copy}`, cat, task && `${task} ${copy}`] : [title, url, cat, task]);
  }
  return buildWindow(rows, 1);
}

/** Map a plan answer {folders:[{name, ids}]} to {assignment, groups, missing}; ids are strip ordinals. */
export function readPlan(answer, tabs) {
  const assignment = new Map();
  const groups = [];
  (Array.isArray(answer?.folders) ? answer.folders : []).forEach((folder, index) => {
    const tabIds = [];
    for (const ordinal of Array.isArray(folder?.ids) ? folder.ids : []) {
      const tab = tabs[ordinal];
      if (!tab || assignment.has(tab.id)) continue;
      assignment.set(tab.id, index);
      tabIds.push(tab.id);
    }
    groups.push({ name: String(folder?.name || ''), tabIds });
  });
  const missing = tabs.filter(tab => !assignment.has(tab.id));
  // Each tab the model left out counts as its own group, so it earns no credit.
  missing.forEach(tab => assignment.set(tab.id, `missing:${tab.id}`));
  return { assignment, groups, missing };
}

export const goldLabels = tabs => new Map(tabs.map(tab => [tab.id, tab.cat]));

/**
 * Pairwise precision, recall and F1 over the tabs that have a gold task
 * (scoring.mjs holds the policy). Tabs missing from the assignment count as
 * singletons.
 */
export function score(assignment, tabs) {
  return { ...pairF1(assignment, tabs, 'tasked'), groups: new Set(assignment.values()).size };
}

/** Same as score(); kept as the name the local scripts use. */
export const pairScore = score;

export const fmt = s => `P ${s.p.toFixed(2)}  R ${s.r.toFixed(2)}  F1 ${s.f1.toFixed(2)}  groups ${s.groups}`;

export function affinity(model, tabs, config) {
  const dense = cosineMatrix(embed(model, tabs.map(tab => [tab.title, urlWords(tab.url)]), config));
  if (!config.wl) return dense;
  const sparse = sparseMatrix(tabs);
  return dense.map((value, index) => value + config.wl * sparse[index]);
}

export function describe(groups, tabs) {
  const byId = new Map(tabs.map(tab => [tab.id, tab]));
  return groups.map(group => {
    const counts = new Map();
    for (const id of group.tabIds) {
      const task = byId.get(id).task || '(none)';
      counts.set(task, (counts.get(task) || 0) + 1);
    }
    const mix = [...counts].sort((a, b) => b[1] - a[1]).map(([task, count]) => `${task}×${count}`).join(', ');
    return `    ${group.name} [${group.tabIds.length}]: ${mix}`;
  }).join('\n');
}

export const keyOf = value => (typeof value === 'string' ? value : value?.c);
export const accuracyOf = (labels, tabs) => tabs.filter(tab => keyOf(labels.get(tab.id)) === tab.cat).length;
export const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;

// --- fixture loading ---------------------------------------------------------

const PILOT_SEEDS = { dev: 7, life: 11 };

/** Shuffle seed for a window: fixed for the two pilot windows, a name hash otherwise. */
export function seedFor(name) {
  if (Object.hasOwn(PILOT_SEEDS, name)) return PILOT_SEEDS[name];
  let hash = 2166136261;
  for (const char of String(name)) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
  return (hash >>> 0) || 1;
}

/** Raw rows of every window in eval/fixtures/*.mjs: {name: [[title, url, cat, task], ...]}. */
export async function loadWindowRows() {
  const rows = {};
  for (const file of fs.readdirSync(FIXTURES_DIR).filter(name => name.endsWith('.mjs')).sort()) {
    const module = await import(pathToFileURL(path.join(FIXTURES_DIR, file)).href);
    for (const [name, list] of Object.entries(module.WINDOWS || {})) {
      if (Object.hasOwn(rows, name)) throw new Error(`Window "${name}" is defined twice (${file})`);
      rows[name] = list;
    }
  }
  return rows;
}

/** Every fixture window as tab objects in its seeded strip order: {name: tabs[]}. */
export async function loadWindows() {
  const rows = await loadWindowRows();
  return Object.fromEntries(Object.entries(rows).map(([name, list]) => [name, buildWindow(list, seedFor(name))]));
}
