// Browser-safe copies of the pieces of eval/lib.mjs the Nano page needs.
// lib.mjs imports node:fs, so a page cannot load it. stub-check.mjs asserts
// these copies give the same windows and scores as lib.mjs, so they cannot drift.

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
    id: position + 1, index: position, title: row[0], url: row[1], cat: row[2], task: row[3], windowId: 1, pinned: false
  }));
}

const PILOT_SEEDS = { dev: 7, life: 11 };

export function seedFor(name) {
  if (Object.hasOwn(PILOT_SEEDS, name)) return PILOT_SEEDS[name];
  let hash = 2166136261;
  for (const char of String(name)) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
  return (hash >>> 0) || 1;
}

/**
 * Pairwise precision, recall and F1 over the tabs that have a gold task; a tab
 * missing from the assignment is its own singleton (eval/scoring.mjs policy).
 */
export function score(assignment, tabs) {
  const scored = tabs.filter(tab => tab.task);
  let tp = 0; let fp = 0; let fn = 0;
  for (let i = 0; i < scored.length; i++) {
    for (let j = i + 1; j < scored.length; j++) {
      const gold = scored[i].task === scored[j].task;
      const predicted = assignment.has(scored[i].id) && assignment.has(scored[j].id) && assignment.get(scored[i].id) === assignment.get(scored[j].id);
      if (gold && predicted) tp++;
      else if (predicted) fp++;
      else if (gold) fn++;
    }
  }
  const p = tp / (tp + fp || 1);
  const r = tp / (tp + fn || 1);
  return { p, r, f1: (2 * p * r) / (p + r || 1), groups: new Set(assignment.values()).size };
}

/**
 * Every fixture window as tab objects: {name: tabs[]}. The caller supplies how
 * to list and import eval/fixtures/*.mjs (fs in Node, a directory listing and
 * dynamic import in the page), so new fixture files are picked up unchanged.
 */
export async function loadWindows({ listFiles, importFile }) {
  const rows = {};
  for (const file of (await listFiles()).filter(name => name.endsWith('.mjs')).sort()) {
    const module = await importFile(file);
    for (const [name, list] of Object.entries(module.WINDOWS || {})) {
      if (Object.hasOwn(rows, name)) throw new Error(`Window "${name}" is defined twice (${file})`);
      rows[name] = list;
    }
  }
  return Object.fromEntries(Object.entries(rows).map(([name, list]) => [name, buildWindow(list, seedFor(name))]));
}
