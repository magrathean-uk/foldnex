/**
 * Foldnex - Local grouping engine
 *
 * Used wherever no model plan is available: average-linkage clusters over
 * idf-weighted title-word overlap (the planner's titleTokens), optionally
 * plus the cosine of embedding vectors the caller supplies. One fixed
 * setting for every window, chosen leave-one-window-out on the twelve
 * evaluation windows (eval/results/rescore.md). The applied result follows
 * eval/scoring.mjs: clusters of two or more tabs, the largest kept within
 * the group limit (Review Later counts as one when any tab is unassigned),
 * everything else unassigned.
 *
 * attachTabs is the upkeep step: a new tab joins the group it is most
 * similar to on average, above a threshold.
 *
 * Pure module: no chrome.* calls, no storage, no clock and no network.
 */

import { MAX_GROUPS, isGenericGroupName } from './ai-engine.js';
import { CATEGORY_BY_KEY, CATEGORY_KEYS, REVIEW_GROUP_NAME } from './label-vocabulary.js';
import {
  categoryFromSite,
  categoryFromTitle,
  ensureUniqueNames,
  isLockedGroup,
  surfaceName,
  titleTokenDetails,
  transferNames,
  validateGroupName
} from './planner.js';
import { describeSite, siteKeyForUrl } from './site-clusterer.js';

/**
 * The fixed settings. tau: merge while the average similarity of the best
 * pair is at least this. With vectors, similarity = cosine + wordWeight x
 * word overlap. attach: the minimum mean title-word similarity for a new tab
 * to join a group. maxShare: when vectors put more than this share of the
 * window's tabs in one cluster, the window is clustered on title words instead
 * (the English-centred table lumps mostly non-English windows). Attach never uses vectors in the product: on title words at
 * 0.05 it scores as well as with them and makes half as many wrong attaches.
 */
export const LOCAL_SETTINGS = Object.freeze({
  words: Object.freeze({ tau: 0.02 }),
  vectors: Object.freeze({ tau: 0.2, wordWeight: 1, maxShare: 0.5 }),
  attach: Object.freeze({ representation: 'mean', theta: 0.05 })
});

const LOCAL_PALETTE = ['blue', 'green', 'purple', 'orange', 'cyan', 'pink', 'yellow', 'red'];
const LOCAL_FALLBACK_NAME = 'Folder';
const REVIEW_KEY = 'review';
const NAME_LIMIT = 30;
// Single words that name nothing on their own (STOP_WORDS covers the commonest).
const FUNCTION_WORDS = new Set([
  'beim', 'mein', 'meine', 'meinen', 'meiner', 'dein', 'deine', 'unser', 'unsere', 'ihre', 'ihr', 'nach', 'über', 'unter',
  'ohne', 'gegen', 'durch', 'zwischen', 'pour', 'avec', 'dans', 'sans', 'sous', 'chez', 'votre', 'notre', 'mes', 'para',
  'sobre', 'entre', 'desde', 'hasta', 'nuestro', 'nuestra', 'como', 'voor', 'mijn', 'onze', 'jouw', 'naar', 'everything',
  'something', 'anything', 'every', 'another', 'again', 'still', 'next', 'last', 'first', 'best', 'like', 'make', 'get'
]);
const CJK_NAME = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** 'function' or 'short' for a one-word name too weak to stand alone, else null. */
function weakSingleWord(name) {
  const text = String(name || '').trim();
  if (/\s/.test(text)) return null;
  if (FUNCTION_WORDS.has(text.toLocaleLowerCase())) return 'function';
  // A CJK word carries a whole concept in two characters.
  if (!CJK_NAME.test(text) && [...text].length < 4) return 'short';
  return null;
}

/** Site brands of the window: lower-case site key or site name -> the tab ids on that site. */
function brandCoverage(tabs) {
  const out = new Map();
  for (const tab of tabs) {
    const url = tabUrl(tab);
    const key = siteKeyForUrl(url);
    if (!key) continue;
    for (const brand of new Set([key, String(describeSite(url).siteName || '').toLocaleLowerCase()])) {
      if (!brand) continue;
      if (!out.has(brand)) out.set(brand, new Set());
      out.get(brand).add(tab.id);
    }
  }
  return out;
}

function tabUrl(tab) {
  return String(tab?.url || tab?.pendingUrl || '');
}

function lookup(tabsById, id) {
  if (!tabsById) return null;
  if (tabsById instanceof Map) return tabsById.get(id) ?? null;
  return tabsById[id] ?? null;
}

function tabsOf(tabsById) {
  if (!tabsById) return [];
  return tabsById instanceof Map ? [...tabsById.values()] : Object.values(tabsById);
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

/** Idf of each token over a population of token sets: log((n + 1) / (df + 0.5)). */
function idfOver(sets) {
  const df = new Map();
  for (const set of sets) for (const token of set) df.set(token, (df.get(token) || 0) + 1);
  const n = sets.length;
  const idf = new Map();
  for (const [token, count] of df) idf.set(token, Math.log((n + 1) / (count + 0.5)));
  return idf;
}

function normOf(set, idf) {
  let sum = 0;
  for (const token of set) sum += (idf.get(token) || 0) ** 2;
  return Math.sqrt(sum) || 1;
}

/**
 * Pairwise similarity of `tabs` (n*n, diagonal 0): idf-weighted cosine of
 * title tokens, plus the vector cosine when `vectors` is given. A tab without
 * a vector contributes word overlap only.
 */
function similarityMatrix(tabs, vectors) {
  const n = tabs.length;
  const sets = tabs.map(tab => titleTokenDetails(tab).tokens);
  const idf = idfOver(sets);
  const norms = sets.map(set => normOf(set, idf));
  // Posting lists let each pair sum only its shared tokens, in the order of
  // the first tab's tokens (the summation order the prototype uses).
  const postings = new Map();
  sets.forEach((set, index) => {
    for (const token of set) {
      if (!postings.has(token)) postings.set(token, []);
      postings.get(token).push(index);
    }
  });
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (const token of sets[i]) {
      const weight = idf.get(token) ** 2;
      for (const j of postings.get(token)) if (j > i) out[i * n + j] += weight;
    }
    for (let j = i + 1; j < n; j++) {
      const value = out[i * n + j] / (norms[i] * norms[j]);
      out[i * n + j] = value;
      out[j * n + i] = value;
    }
  }
  if (!vectors) return out;
  const weight = LOCAL_SETTINGS.vectors.wordWeight;
  const rows = tabs.map(tab => vectors.get(tab.id) || null);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let cosine = 0;
      const a = rows[i];
      const b = rows[j];
      if (a && b) for (let d = 0; d < a.length; d++) cosine += a[d] * b[d];
      const value = cosine + weight * out[i * n + j];
      out[i * n + j] = value;
      out[j * n + i] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Average linkage
// ---------------------------------------------------------------------------

/**
 * Average-linkage merges on similarity S (n*n) while the best pair is at
 * least tau, with a nearest-neighbour cache per cluster (the form measured in
 * eval/local-cluster.mjs). Returns clusters as sorted index arrays ordered by
 * first member.
 */
function averageLinkage(S, n, tau) {
  const sim = Float64Array.from(S);
  const active = new Uint8Array(n).fill(1);
  const size = new Float64Array(n).fill(1);
  const best = new Float64Array(n);
  const bestJ = new Int32Array(n);
  const parent = Int32Array.from({ length: n }, (_, index) => index);
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
  for (let step = 0; step < n - 1; step++) {
    let i = -1;
    for (let k = 0; k < n; k++) if (active[k] && bestJ[k] >= 0 && (i < 0 || best[k] > best[i])) i = k;
    // Heights never increase, so the first merge below tau ends the run.
    if (i < 0 || best[i] < tau) break;
    const j = bestJ[i];
    const a = Math.min(i, j);
    const b = Math.max(i, j);
    parent[b] = a;
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
  // Each merged cluster is kept under its smallest index.
  const find = x => {
    while (parent[x] !== x) x = parent[x];
    return x;
  };
  const byRoot = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(i);
  }
  return [...byRoot.values()];
}

/**
 * Cluster a window's tabs. `vectors`: Map of tab id to a unit Float32Array,
 * or null for title words only. `limit`: the most groups, counting Review
 * Later when any tab is unassigned. Returns {groups: [{tabIds}], unassigned}
 * with groups in order of first member, plus `channel`: 'vectors' when the
 * vectors made the clusters, 'words' when title words did (none given, or the
 * vectors' largest cluster held more than LOCAL_SETTINGS.vectors.maxShare of
 * the tabs). Deterministic for a given tab order.
 */
export function clusterTabs(tabs, { vectors = null, limit = MAX_GROUPS } = {}) {
  const { groups, unassigned, channel } = clusterWindow(tabs, vectors, limit);
  return { groups, unassigned, channel };
}

/** clusterTabs plus `dropped`, the clusters of two or more tabs cut by the limit. */
function clusterWindow(tabs, vectors, limit) {
  const list = Array.isArray(tabs) ? tabs : [];
  const n = list.length;
  if (n === 0) return { groups: [], unassigned: [], dropped: 0, channel: 'words' };
  let useVectors = vectors instanceof Map && vectors.size > 0;
  let clusters = null;
  if (useVectors && n >= 2) {
    clusters = averageLinkage(similarityMatrix(list, vectors), n, LOCAL_SETTINGS.vectors.tau);
    const largest = Math.max(...clusters.map(cluster => cluster.length));
    if (largest > n * LOCAL_SETTINGS.vectors.maxShare) {
      useVectors = false;
      clusters = null;
    }
  }
  if (!clusters) clusters = n < 2 ? [[0]] : averageLinkage(similarityMatrix(list, null), n, LOCAL_SETTINGS.words.tau);

  const kept = clusters.filter(cluster => cluster.length >= 2).map((cluster, order) => ({ cluster, order }));
  const cap = Math.max(1, Math.floor(Number(limit) || MAX_GROUPS));
  const anyUnassigned = kept.reduce((sum, item) => sum + item.cluster.length, 0) < n;
  const room = anyUnassigned || kept.length > cap ? cap - 1 : cap;
  const survivors = new Set([...kept]
    .sort((x, y) => y.cluster.length - x.cluster.length || x.order - y.order)
    .slice(0, Math.max(0, room)));
  const groups = kept.filter(item => survivors.has(item)).map(item => ({ tabIds: item.cluster.map(index => list[index].id) }));
  const assigned = new Set(groups.flatMap(group => group.tabIds));
  return {
    groups,
    unassigned: list.map(tab => tab.id).filter(id => !assigned.has(id)),
    dropped: kept.length - groups.length,
    channel: useVectors ? 'vectors' : 'words'
  };
}

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

/**
 * Attach new tabs to existing groups. Each new tab joins the group whose
 * members it is most similar to on average (first best wins a tie) when that
 * mean is at least `theta`; otherwise it is unplaced. Review Later and locked
 * groups never receive tabs. Idf is taken over every tab in `tabsById` plus
 * any new tab missing from it. `newTabs` are tabs or tab ids in `tabsById`.
 * "Title words" here are the planner's titleTokens: the title's words plus a
 * project token from known hosts (a code host's repository name). That is the
 * channel measured for clustering and for attach (D28), so a new issue in the
 * same repository can join on the repository name alone.
 * `vectors` exists for the evaluation; product callers pass none.
 * Returns {placed: Map<tabId, groupIndex>, unplaced: [tabId]}.
 */
export function attachTabs(groups, newTabs, tabsById, { vectors = null, theta } = {}) {
  const useVectors = vectors instanceof Map && vectors.size > 0;
  const threshold = Number.isFinite(theta) ? theta : LOCAL_SETTINGS.attach.theta;
  const incoming = (Array.isArray(newTabs) ? newTabs : [])
    .map(entry => (entry && typeof entry === 'object' ? entry : lookup(tabsById, entry)))
    .filter(tab => tab && tab.id !== undefined && tab.id !== null);

  const population = new Map(tabsOf(tabsById).filter(tab => tab && tab.id !== undefined).map(tab => [tab.id, tab]));
  for (const tab of incoming) if (!population.has(tab.id)) population.set(tab.id, tab);
  const tokens = new Map([...population].map(([id, tab]) => [id, titleTokenDetails(tab).tokens]));
  const idf = idfOver([...tokens.values()]);
  const norms = new Map([...tokens].map(([id, set]) => [id, normOf(set, idf)]));
  const weight = useVectors ? LOCAL_SETTINGS.vectors.wordWeight : 1;
  const similarity = (a, b) => {
    const left = tokens.get(a);
    const right = tokens.get(b);
    let dot = 0;
    for (const token of left) if (right.has(token)) dot += idf.get(token) ** 2;
    let value = weight * (dot / (norms.get(a) * norms.get(b)));
    if (useVectors) {
      const va = vectors.get(a);
      const vb = vectors.get(b);
      if (va && vb) for (let d = 0; d < va.length; d++) value += va[d] * vb[d];
    }
    return value;
  };

  const targets = (Array.isArray(groups) ? groups : []).map((group, index) => ({
    index,
    members: group && group.kind !== 'review' && !isLockedGroup(group)
      ? (group.tabIds || []).filter(id => tokens.has(id))
      : []
  })).filter(target => target.members.length > 0);

  const placed = new Map();
  const unplaced = [];
  for (const tab of incoming) {
    let best = -Infinity;
    let choice = -1;
    for (const target of targets) {
      let sum = 0;
      let count = 0;
      for (const id of target.members) {
        if (id === tab.id) continue;
        sum += similarity(tab.id, id);
        count++;
      }
      if (count === 0) continue;
      const mean = sum / count;
      if (mean > best) {
        best = mean;
        choice = target.index;
      }
    }
    if (choice >= 0 && best >= threshold) placed.set(tab.id, choice);
    else unplaced.push(tab.id);
  }
  return { placed, unplaced };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

function clamp(name) {
  const chars = [...String(name || '').trim()];
  return chars.length <= NAME_LIMIT ? chars.join('') : chars.slice(0, NAME_LIMIT).join('').trim();
}

/** The most frequent key of a count map, ties by `order`: {key, count}. */
function leader(counts, order) {
  let key = null;
  let count = 0;
  for (const candidate of order) {
    const value = counts.get(candidate) || 0;
    if (value > count) {
      key = candidate;
      count = value;
    }
  }
  return { key, count };
}

function categoryCounts(tabs) {
  const counts = new Map();
  for (const tab of tabs) {
    // The site taxonomy, then title words: what a tab says about itself.
    const key = categoryFromSite(tabUrl(tab)) || categoryFromTitle(tab?.title);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function siteCounts(tabs) {
  const counts = new Map();
  const colors = new Map();
  for (const tab of tabs) {
    const url = tabUrl(tab);
    if (!siteKeyForUrl(url)) continue;
    const { siteName, color } = describeSite(url);
    if (!siteName || isGenericGroupName(siteName)) continue;
    counts.set(siteName, (counts.get(siteName) || 0) + 1);
    if (!colors.has(siteName)) colors.set(siteName, color);
  }
  return { counts, colors, order: [...counts.keys()].sort() };
}

/**
 * Distinctive shared title words of a group: tokens in at least two members,
 * ranked by members x window idf (ties: more members, then alphabetical).
 * Returns name candidates, two words first when the runner-up shares at
 * least half of the leader's tabs, then the leader alone.
 */
function wordCandidates(memberDetails, idf) {
  const counts = new Map();
  for (const details of memberDetails) for (const token of details.tokens) counts.set(token, (counts.get(token) || 0) + 1);
  const ranked = [...counts]
    .filter(([, count]) => count >= 2)
    .map(([token, count]) => ({ token, count, score: count * (idf.get(token) || 0) }))
    .sort((a, b) => b.score - a.score || b.count - a.count || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
  if (ranked.length === 0) return [];
  const [first, ...rest] = ranked;
  const word = token => surfaceName(token, memberDetails);
  const out = [];
  const withFirst = memberDetails.filter(details => details.tokens.has(first.token));
  // A leader too weak to stand alone takes any partner it shares two tabs with.
  const needed = weakSingleWord(word(first.token)) ? 2 : Math.max(2, Math.ceil(withFirst.length / 2));
  for (const second of rest) {
    const both = withFirst.filter(details => details.tokens.has(second.token));
    if (both.length < needed) continue;
    // Title order of the first member holding both words.
    const order = [...both[0].tokens];
    const pair = order.indexOf(first.token) < order.indexOf(second.token) ? [first, second] : [second, first];
    out.push(pair.map(item => word(item.token)).join(' '));
    break;
  }
  out.push(word(first.token));
  return out;
}

/**
 * Name and colour of one local group: the category of more than half of its
 * tabs, then the site of more than half, then distinctive shared words, then
 * a category or site of at least half; every candidate through
 * validateGroupName against the names already taken.
 */
function nameGroup(group, memberTabs, memberDetails, idf, tabsById, taken, index, brands = new Map()) {
  const size = memberTabs.length;
  const category = leader(categoryCounts(memberTabs), CATEGORY_KEYS);
  const sites = siteCounts(memberTabs);
  const site = leader(sites.counts, sites.order);
  const plurality = category.key;
  const fallbackColor = CATEGORY_BY_KEY.get(plurality)?.color || LOCAL_PALETTE[index % LOCAL_PALETTE.length];
  const byCategory = () => ({ name: CATEGORY_BY_KEY.get(plurality).name, color: CATEGORY_BY_KEY.get(plurality).color, dominant: plurality });
  const bySite = () => ({ name: clamp(site.key), color: CATEGORY_BY_KEY.get(plurality)?.color || sites.colors.get(site.key) || fallbackColor, dominant: plurality });

  const candidates = [];
  if (category.key && category.count * 2 > size) candidates.push(byCategory());
  if (site.key && site.count * 2 > size) candidates.push(bySite());
  for (const name of wordCandidates(memberDetails, idf)) candidates.push({ name: clamp(name), color: fallbackColor, dominant: plurality });
  if (category.key && category.count * 2 === size) candidates.push(byCategory());
  if (site.key && site.count * 2 === size) candidates.push(bySite());

  // Never digits only, never a bare brand that also covers tabs outside the
  // group, never a lone function word; a short single word goes last.
  const members = new Set(group.tabIds);
  const usable = candidates.filter(candidate => {
    if (!/\p{L}/u.test(candidate.name)) return false;
    const covered = brands.get(String(candidate.name).toLocaleLowerCase());
    if (covered && [...covered].some(id => !members.has(id))) return false;
    return weakSingleWord(candidate.name) !== 'function';
  });
  const ordered = [...usable.filter(candidate => !weakSingleWord(candidate.name)), ...usable.filter(candidate => weakSingleWord(candidate.name))];

  for (const candidate of ordered) {
    // A category name must speak for at least half of the group's tabs.
    const probe = { ...group, categories: candidate.dominant && candidate.name === CATEGORY_BY_KEY.get(candidate.dominant)?.name ? [candidate.dominant] : [] };
    const name = validateGroupName(candidate.name, probe, tabsById, taken);
    if (name) return { ...candidate, name };
  }
  return { name: LOCAL_FALLBACK_NAME, color: fallbackColor, dominant: plurality };
}

// ---------------------------------------------------------------------------
// The local plan
// ---------------------------------------------------------------------------

/**
 * Plan a window locally, in the shape of enforcePlan: locked groups first,
 * the clusters as named and coloured groups, then one Review Later group for
 * the unassigned tabs. MAX_GROUPS counts locked groups and Review Later.
 * User renames in `memory` win, as in enforcePlan. `vectors` is the seam for
 * embedding vectors (Map of tab id to unit Float32Array), null for title
 * words only. Returns {groups, unassigned, dropped, folders, channel}.
 */
export function planLocally(pool, {
  locked = [], tabsById = null, vectors = null, memory = null, fingerprintById = null
} = {}) {
  const lockedGroups = (locked || []).filter(group => (group?.tabIds || []).length > 0);
  const lockedIds = new Set(lockedGroups.flatMap(group => group.tabIds));
  const rows = (Array.isArray(pool) ? pool : []).filter(tab => tab && !lockedIds.has(tab.id));
  const byId = tabsById || new Map(rows.map(tab => [tab.id, tab]));
  const limit = Math.max(1, MAX_GROUPS - lockedGroups.length);

  const clustered = clusterWindow(rows, vectors, limit);
  const detailsById = new Map(rows.map(tab => [tab.id, titleTokenDetails(tab)]));
  const idf = idfOver([...detailsById.values()].map(details => details.tokens));
  const rowById = new Map(rows.map(tab => [tab.id, tab]));
  const brands = brandCoverage(rows);

  const taken = [...lockedGroups.map(group => group.name), REVIEW_GROUP_NAME];
  // Larger groups choose names first; ties by strip order.
  const order = clustered.groups.map((group, index) => index)
    .sort((a, b) => clustered.groups[b].tabIds.length - clustered.groups[a].tabIds.length || a - b);
  const planned = new Array(clustered.groups.length);
  for (const index of order) {
    const tabIds = clustered.groups[index].tabIds;
    const key = `local:${index}`;
    const group = { tabIds, key, keys: [key], kind: 'folder' };
    const identity = nameGroup(group, tabIds.map(id => rowById.get(id)), tabIds.map(id => detailsById.get(id)), idf, byId, taken, index, brands);
    planned[index] = {
      name: identity.name,
      color: identity.color,
      tabIds: [...tabIds],
      key,
      keys: [key],
      dominant: identity.dominant || null,
      kind: 'folder',
      nameSource: 'deterministic'
    };
    taken.push(identity.name);
  }

  const userMemory = memory ? { names: (memory.names || []).filter(record => record?.s === 'user') } : null;
  const named = transferNames(planned, userMemory, { tabsById: byId, fingerprintById });
  const review = clustered.unassigned.length ? [{
    name: REVIEW_GROUP_NAME, color: 'grey', tabIds: [...clustered.unassigned], key: REVIEW_KEY, keys: [REVIEW_KEY],
    dominant: null, kind: 'review', nameSource: 'deterministic'
  }] : [];
  const lockedOut = lockedGroups.map(group => ({ ...group, tabIds: [...group.tabIds], locked: true }));
  return {
    groups: ensureUniqueNames([...lockedOut, ...named, ...review], [], { tabsById: byId, joinLocked: false }),
    unassigned: [...clustered.unassigned],
    dropped: clustered.dropped,
    folders: clustered.groups.length,
    channel: clustered.channel
  };
}
