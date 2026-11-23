// Plan upkeep (design part 3): a window's gold groups stand in for a stored
// model plan. A share of the tabs is hidden, each group keeps its remaining
// tabs, and every hidden tab with a gold task is attached to the most similar
// group or left unattached below a threshold. This starts from ideal stored
// groups and is optimistic; rescore.mjs replays upkeep from recorded model
// plans and attaches every hidden tab. Not product code.
import { mulberry32, pairScore } from './lib.mjs';

export const REPS = ['mean', 'max', 'centroid'];

/** Seeded hidden set: a share of all tabs (rounded, at least one). */
export function hiddenSet(tabs, share, seed) {
  const random = mulberry32(seed);
  const order = tabs.map((tab, index) => ({ index, key: random() })).sort((a, b) => a.key - b.key);
  const count = Math.max(1, Math.round(share * tabs.length));
  return new Set(order.slice(0, count).map(item => item.index));
}

/**
 * The attach step's similarity of a tab to stored groups [{key, members}]
 * (members are window indices). Returns (i, rep) -> {group, score}: the best
 * group's key under one representation (first best wins ties). S is the
 * window affinity (n*n), V the unit dense vectors, sparse the exact-word
 * affinity and wl its weight (for the centroid form).
 */
export function groupScorer(groups, S, V, sparse, wl) {
  const n = Math.round(Math.sqrt(S.length));
  const dim = V[0].length;
  const centroids = groups.map(({ members }) => {
    const c = new Float64Array(dim);
    for (const i of members) for (let d = 0; d < dim; d++) c[d] += V[i][d];
    let norm = 0;
    for (let d = 0; d < dim; d++) norm += c[d] * c[d];
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dim; d++) c[d] /= norm;
    return c;
  });
  return (i, rep) => {
    let best = -Infinity;
    let group = null;
    groups.forEach(({ key, members }, g) => {
      let value;
      if (rep === 'mean') {
        value = 0;
        for (const j of members) value += S[i * n + j];
        value /= members.length;
      } else if (rep === 'max') {
        value = -Infinity;
        for (const j of members) value = Math.max(value, S[i * n + j]);
      } else {
        value = 0;
        for (let d = 0; d < dim; d++) value += V[i][d] * centroids[g][d];
        if (wl) {
          let lexical = 0;
          for (const j of members) lexical += sparse[i * n + j];
          value += (wl * lexical) / members.length;
        }
      }
      if (value > best) {
        best = value;
        group = key;
      }
    });
    return { group, score: best };
  };
}

/**
 * For each hidden tab with a gold task: its best gold group and score under
 * each representation, with the surviving gold groups as the stored plan.
 */
export function attachCandidates(tabs, hidden, S, V, sparse, wl) {
  const groups = new Map();
  tabs.forEach((tab, index) => {
    if (hidden.has(index) || !tab.task) return;
    if (!groups.has(tab.task)) groups.set(tab.task, []);
    groups.get(tab.task).push(index);
  });
  const best = groupScorer([...groups].map(([key, members]) => ({ key, members })), S, V, sparse, wl);
  const out = [];
  for (const i of [...hidden].sort((a, b) => a - b)) {
    if (!tabs[i].task) continue;
    const row = { index: i, gold: tabs[i].task };
    for (const rep of REPS) row[rep] = best(i, rep);
    out.push(row);
  }
  return out;
}

/** Attach counts (attached, right, total hidden task tabs) and grouping F1 for one hidden set at threshold theta. */
export function upkeepScore(tabs, hidden, candidates, rep, theta) {
  const assignment = new Map();
  tabs.forEach((tab, index) => {
    if (!hidden.has(index) && tab.task) assignment.set(tab.id, `g:${tab.task}`);
    else assignment.set(tab.id, `s:${tab.id}`);
  });
  let attached = 0;
  let right = 0;
  for (const row of candidates) {
    const choice = row[rep];
    if (choice.group === null || choice.score < theta) continue;
    attached++;
    if (choice.group === row.gold) right++;
    assignment.set(tabs[row.index].id, `g:${choice.group}`);
  }
  return { attached, right, total: candidates.length, f1: pairScore(assignment, tabs).f1 };
}
