// Two small things the evaluation kept using from src/ that the Phase 4 removal of the per-tab label
// pipeline takes away. Frozen copies, so the live scripts do not depend on them. Not product code.

// Copy of CATEGORY_KEYS in src/label-vocabulary.js at c669dcb: the category keys of the fixtures and of
// data/titles.jsonl. node eval/check.mjs validates both against this list.
export const CATEGORY_KEYS = Object.freeze([
  'dev', 'ai', 'infra', 'design', 'office', 'mail', 'biz', 'jobs', 'learn', 'news', 'read', 'video',
  'games', 'sport', 'shop', 'money', 'travel', 'food', 'home', 'health', 'cars', 'events', 'admin'
]);

// Copy of taskMin() in src/planner.js at c669dcb: the smallest cluster of a window of n tabs that
// local-cluster.mjs tasksFromClusters() keeps as a task: 3 tabs, or 5% of the window.
export function taskMin(n) {
  return Math.max(3, Math.ceil(0.05 * n));
}
