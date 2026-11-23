// The one scoring policy of the grouping evaluation. Not product code.
//
// Applied result: what a window would look like after a method's answer is
// applied. Each tab is in at most one group (first placement wins, unknown
// ids are ignored). Tabs the method leaves out, and tabs in a group named
// "Review Later" (any case), are unassigned. At most ten groups; the Review
// Later pool counts as one of the ten when any tab is unassigned. Over the
// limit, the largest groups stay (ties by first appearance) and the tabs of
// the rest become unassigned.
//
// Scores: pairwise precision, recall and F1, with every tab missing from an
// assignment counted as its own singleton. Two populations:
//   tasked : pairs among tabs that have a gold task (the original benchmark);
//   all    : every tab; a tab without a gold task is a gold singleton.

export const GROUP_LIMIT = 10;
export const REVIEW_LATER = 'review later';

export const isReviewLater = name => String(name ?? '').trim().toLowerCase() === REVIEW_LATER;

/**
 * Applied result of a method's groups [{name, ids}] (ids are tab ids, in the
 * method's order). Returns {assignment: Map id -> group index, groups:
 * [{name, ids}], unassigned: [ids], dropped: number of groups cut by the cap}.
 */
export function applyGroups(groups, tabs, limit = GROUP_LIMIT) {
  const known = new Set(tabs.map(tab => tab.id));
  const placed = new Set();
  const kept = [];
  groups.forEach((group, order) => {
    const ids = [];
    for (const id of group.ids || []) {
      if (!known.has(id) || placed.has(id)) continue;
      placed.add(id);
      ids.push(id);
    }
    if (!isReviewLater(group.name) && ids.length) kept.push({ name: String(group.name ?? ''), ids, order });
  });
  const anyUnassigned = kept.reduce((sum, group) => sum + group.ids.length, 0) < tabs.length;
  const room = anyUnassigned || kept.length > limit ? limit - 1 : limit;
  const survivors = new Set([...kept].sort((a, b) => b.ids.length - a.ids.length || a.order - b.order).slice(0, room));
  const applied = kept.filter(group => survivors.has(group));
  const assignment = new Map();
  applied.forEach((group, index) => group.ids.forEach(id => assignment.set(id, index)));
  return {
    assignment,
    groups: applied.map(({ name, ids }) => ({ name, ids })),
    unassigned: tabs.filter(tab => !assignment.has(tab.id)).map(tab => tab.id),
    dropped: kept.length - applied.length
  };
}

const pairs = count => (count * (count - 1)) / 2;

/** Pair counts {tp, predicted, gold} of an assignment over a population ('tasked' or 'all'). */
export function pairCounts(assignment, tabs, population = 'tasked') {
  const cell = new Map();
  const byGroup = new Map();
  const byTask = new Map();
  for (const tab of tabs) {
    if (population === 'tasked' && !tab.task) continue;
    const group = assignment.has(tab.id) ? `g\u0000${assignment.get(tab.id)}` : `s\u0000${tab.id}`;
    const task = tab.task ? `t\u0000${tab.task}` : `s\u0000${tab.id}`;
    const key = `${group}\u0001${task}`;
    cell.set(key, (cell.get(key) || 0) + 1);
    byGroup.set(group, (byGroup.get(group) || 0) + 1);
    byTask.set(task, (byTask.get(task) || 0) + 1);
  }
  let tp = 0;
  let predicted = 0;
  let gold = 0;
  for (const count of cell.values()) tp += pairs(count);
  for (const count of byGroup.values()) predicted += pairs(count);
  for (const count of byTask.values()) gold += pairs(count);
  return { tp, predicted, gold };
}

/** {p, r, f1} from pair counts. */
export function prf({ tp, predicted, gold }) {
  const p = tp / (predicted || 1);
  const r = tp / (gold || 1);
  return { p, r, f1: (2 * p * r) / (p + r || 1) };
}

/** Pairwise P/R/F1 of an assignment; tabs missing from it are singletons. */
export function pairF1(assignment, tabs, population = 'tasked') {
  return prf(pairCounts(assignment, tabs, population));
}

/** Both scores of an assignment: {tasked, all}. */
export const bothScores = (assignment, tabs) => ({ tasked: pairF1(assignment, tabs, 'tasked'), all: pairF1(assignment, tabs, 'all') });

/**
 * Raw validity of a plan answer {folders: [{name, ids}]} whose ids are strip
 * ordinals: omitted tabs, duplicate and unknown ids, and the folder count.
 */
export function planValidity(answer, tabs, limit = GROUP_LIMIT) {
  const folders = Array.isArray(answer?.folders) ? answer.folders : [];
  const seen = new Set();
  let duplicates = 0;
  let unknown = 0;
  for (const folder of folders) {
    for (const id of Array.isArray(folder?.ids) ? folder.ids : []) {
      if (!Number.isInteger(id) || id < 0 || id >= tabs.length) unknown++;
      else if (seen.has(id)) duplicates++;
      else seen.add(id);
    }
  }
  return { omitted: tabs.length - seen.size, duplicates, unknown, folders: folders.length, overLimit: folders.length > limit };
}

/** A plan answer as groups of tab ids (ordinals mapped through the strip; unknown ordinals kept as null, which applyGroups ignores). */
export const planGroupsOf = (answer, tabs) => (Array.isArray(answer?.folders) ? answer.folders : [])
  .map(folder => ({ name: folder?.name, ids: (Array.isArray(folder?.ids) ? folder.ids : []).map(ordinal => (Number.isInteger(ordinal) ? tabs[ordinal]?.id ?? null : null)) }));
