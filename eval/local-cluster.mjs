// Average-linkage clustering as a dendrogram, so every tau is one cut of one
// run. Same merges as lib agglomerate() (merge the best pair while it is at
// least tau): average linkage is monotone, so "merge while >= tau" is a
// prefix of the merge sequence. Not product code.
import { taskMin } from './frozen.mjs';

/** Merges of average linkage on similarity S (n*n): [{a, b, height}], heights non-increasing. */
export function dendrogram(S, n) {
  const sim = Float64Array.from(S);
  const active = new Uint8Array(n).fill(1);
  const size = new Float64Array(n).fill(1);
  const best = new Float64Array(n);
  const bestJ = new Int32Array(n);
  const rescan = i => {
    best[i] = -Infinity;
    bestJ[i] = -1;
    for (let j = 0; j < n; j++) {
      if (j === i || !active[j]) continue;
      if (sim[i * n + j] > best[i]) {
        best[i] = sim[i * n + j];
        bestJ[i] = j;
      }
    }
  };
  for (let i = 0; i < n; i++) rescan(i);
  const merges = [];
  for (let step = 0; step < n - 1; step++) {
    let i = -1;
    for (let k = 0; k < n; k++) if (active[k] && bestJ[k] >= 0 && (i < 0 || best[k] > best[i])) i = k;
    if (i < 0) break;
    const j = bestJ[i];
    const a = Math.min(i, j);
    const b = Math.max(i, j);
    merges.push({ a, b, height: best[i] });
    const total = size[a] + size[b];
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === a || k === b) continue;
      const value = (size[a] * sim[a * n + k] + size[b] * sim[b * n + k]) / total;
      sim[a * n + k] = value;
      sim[k * n + a] = value;
    }
    size[a] = total;
    active[b] = 0;
    rescan(a);
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === a) continue;
      if (bestJ[k] === a || bestJ[k] === b) rescan(k);
      else if (sim[k * n + a] > best[k] || (sim[k * n + a] === best[k] && a < bestJ[k])) {
        best[k] = sim[k * n + a];
        bestJ[k] = a;
      }
    }
  }
  return merges;
}

/** Clusters after every merge at height >= tau: arrays of indices, each sorted, ordered by first member. */
export function cut(merges, n, tau) {
  const parent = Int32Array.from({ length: n }, (_, index) => index);
  const find = x => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (const merge of merges) {
    if (merge.height < tau) break;
    const ra = find(merge.a);
    const rb = find(merge.b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
  const byRoot = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(i);
  }
  return [...byRoot.values()];
}

/** lib semanticTasks() from a dendrogram: clusters of taskMin(n) to n/2 tabs as locked groups. */
export function tasksFromClusters(clusters, tabs) {
  const n = tabs.length;
  return clusters
    .filter(cluster => cluster.length >= taskMin(n) && cluster.length <= 0.5 * n)
    .map((cluster, index) => ({ name: `Semantic ${index + 1}`, color: 'blue', kind: 'rule', tabIds: cluster.map(i => tabs[i].id) }));
}

/** Clusters straight to groups (no planner): the 10 largest clusters of 2+ tabs; the rest stay single. */
export function clusterAssignment(clusters, tabs, limit = 10) {
  const ranked = clusters.map((cluster, order) => ({ cluster, order }))
    .sort((x, y) => y.cluster.length - x.cluster.length || x.order - y.order);
  const assignment = new Map();
  ranked.forEach(({ cluster }, rank) => {
    cluster.forEach(i => assignment.set(tabs[i].id, rank < limit && cluster.length >= 2 ? `c${rank}` : `s${tabs[i].id}`));
  });
  return assignment;
}
