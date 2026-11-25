/**
 * Foldnex - Group Orchestrator
 * Connects tab querying, the caches, the plan request, the local engine
 * and the native Chrome tabGroups API.
 */

import {
  ExactResultCache,
  LearningCache,
  PlanMemory,
  PlanOfferStore,
  WindowPlanStore,
  fingerprintTab,
  hashToken,
  readResetEpoch,
  tabSetSignature
} from './cache-engine.js';
import {
  assessGroupingQuality,
  CHROME_GROUP_COLORS,
  getEffectiveReasoningEffort,
  groupCeiling,
  isCloudProvider,
  isLoopbackUrl,
  labelCacheScope,
  MAX_GROUPS,
  planReasoningEffort,
  planWindowWithCloud,
  PROVIDER_CATALOG,
  providerSettingKey,
  resolveProvider
} from './ai-engine.js';
import {
  categoryFromSite,
  enforceGroupCeiling,
  enforcePlan,
  ensureUniqueNames,
  planSignature,
  REVIEW_GROUP_NAME,
  transferNames
} from './planner.js';
import { attachTabs, planLocally } from './local-engine.js';
import { embedWindow, loadTable, urlWords } from './embedder.js';
import { clusterTabsBySite, isSocialSite } from './site-clusterer.js';
import { markProgrammaticGroupUpdate } from './group-state.js';
import { createTrace, noopTrace } from './debug-trace.js';
import { loadSettings } from './settings.js';

const RUN_HISTORY_KEY = 'foldnex_run_history_v1';
const RUN_HISTORY_LIMIT = 20;
// Cloud engines and Ollama now plan the window in one request; results
// cached under the label pipeline are not reused.
const PROMPT_VERSION = 'plan-v1-window';
const SAFE_INTERNAL_DUPLICATE_PAGES = new Set([
  'extensions', 'downloads', 'history', 'bookmarks'
]);

// One deadline governs a click. Model work stops APPLY_RESERVE_MS before it
// so the strip is always regrouped on time; late answers only fill caches.
export const CLICK_BUDGET_MS = 4500;
// A cloud or Ollama click waits this long in total for its one plan request.
export const PLAN_CLICK_BUDGET_MS = 6000;
// A click attaches new tabs to the last model plan, with no request, while
// they are at most this share of the window's unlocked tabs.
export const UPKEEP_SHARE = 0.1;
const DIGEST_CHARS = 16;
export const APPLY_RESERVE_MS = 600;
// Owner decision pending: By site category keeps its 15-30 group contract.
export const APPLY_CEILING_TO_SITE_MODE = false;

function isRouteLikeFragment(fragment) {
  return fragment.startsWith('/') || fragment.startsWith('!') || /[/?=&]/.test(fragment);
}

/**
 * Return a conservative page identity. Ordinary document anchors are ignored,
 * while route-like fragments are preserved for hash-routed applications.
 * A short allowlist of stateless Chrome pages may also be deduplicated exactly.
 */
export function getDuplicateTabKey(tab) {
  const rawUrl = tab?.url || tab?.pendingUrl;
  if (!rawUrl || typeof rawUrl !== 'string') return null;

  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'chrome:' && SAFE_INTERNAL_DUPLICATE_PAGES.has(url.hostname)) {
      return url.href;
    }
    if (!['http:', 'https:'].includes(url.protocol)) return null;

    const fragment = url.hash.slice(1);
    if (!fragment || !isRouteLikeFragment(fragment)) url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function modelForSettings(settings) {
  const provider = resolveProvider(settings.provider);
  const config = PROVIDER_CATALOG[provider];
  if (provider === 'gemini_api') return settings.geminiModel || config.defaultModel || 'gemini';
  if (config.mode === 'compatible' || config.mode === 'anthropic') {
    return settings[providerSettingKey(provider, 'model')] || config.defaultModel || 'default';
  }
  return provider;
}

function mergeExplicitGroups(groups, explicitGroups) {
  if (!explicitGroups?.length) return groups;
  const explicitIds = new Set(explicitGroups.flatMap(group => group.tabs.map(tab => tab.id)));
  const retained = (groups || []).map(group => ({
    ...group,
    tabIds: (group.tabIds || []).filter(id => !explicitIds.has(id))
  })).filter(group => group.tabIds.length > 0);

  for (const explicit of explicitGroups) {
    const existing = retained.find(group => group.name.toLowerCase() === explicit.name.toLowerCase());
    const ids = explicit.tabs.map(tab => tab.id);
    if (existing) existing.tabIds.push(...ids);
    else retained.push({ name: explicit.name, color: explicit.color || 'blue', tabIds: ids });
  }
  return retained;
}

/** Merge groups that share a name, keeping the first group's color. */
export function mergeGroupsByName(groups) {
  const byName = new Map();
  for (const group of groups || []) {
    const key = String(group.name || '').toLowerCase();
    const existing = byName.get(key);
    if (existing) existing.tabIds = [...existing.tabIds, ...(group.tabIds || [])];
    else byName.set(key, { ...group, tabIds: [...(group.tabIds || [])] });
  }
  return [...byName.values()];
}

async function recordRun(run) {
  const data = await chrome.storage.local.get(RUN_HISTORY_KEY);
  const history = Array.isArray(data[RUN_HISTORY_KEY]) ? data[RUN_HISTORY_KEY] : [];
  history.unshift(run);
  await chrome.storage.local.set({
    foldnex_last_run: run,
    [RUN_HISTORY_KEY]: history.slice(0, RUN_HISTORY_LIMIT)
  });
}

function classifyProviderFailure(error) {
  // The engine's optional host permission is not granted: nothing was sent.
  if (error?.code === 'permission') return { code: 'permission', detail: 'Host access for this engine is not allowed in Chrome' };
  const message = String(error?.message || '');
  if (/429|quota/i.test(message)) return { code: 'quota', detail: 'Provider quota or rate limit reached' };
  if (/401|API key/i.test(message)) return { code: 'auth', detail: 'Provider authentication failed' };
  if (/timed out|abort/i.test(message)) return { code: 'timeout', detail: 'Provider timed out' };
  return { code: 'provider_error', detail: 'Provider request failed' };
}

/**
 * Close redundant pages before grouping. Pinned tabs always win; otherwise
 * preserve the active tab, then the leftmost tab, as the canonical survivor.
 * Only the explicitly safe internal Chrome pages accepted above participate.
 */
export async function eliminateDuplicateTabs(tabs, windowId) {
  const duplicatesByUrl = new Map();
  for (const tab of tabs) {
    const key = getDuplicateTabKey(tab);
    if (!key) continue;
    const duplicates = duplicatesByUrl.get(key) || [];
    duplicates.push(tab);
    duplicatesByUrl.set(key, duplicates);
  }

  let closedCount = 0;
  for (const [key, duplicates] of duplicatesByUrl) {
    if (duplicates.length < 2) continue;

    const [survivor, ...candidates] = [...duplicates].sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      if (Boolean(a.active) !== Boolean(b.active)) return a.active ? -1 : 1;
      return (a.index ?? Infinity) - (b.index ?? Infinity);
    });

    // Do not remove a copy if the chosen canonical tab vanished or navigated.
    let survivorIsPinned = false;
    try {
      const liveSurvivor = await chrome.tabs.get(survivor.id);
      if (liveSurvivor.windowId !== windowId || getDuplicateTabKey(liveSurvivor) !== key) continue;
      survivorIsPinned = Boolean(liveSurvivor.pinned);
    } catch {
      continue;
    }

    for (const candidate of candidates) {
      try {
        const liveCandidate = await chrome.tabs.get(candidate.id);
        if (
          liveCandidate.windowId === windowId &&
          // Never remove a pinned tab in favour of a now-unpinned survivor.
          !(liveCandidate.pinned && !survivorIsPinned) &&
          getDuplicateTabKey(liveCandidate) === key
        ) {
          await chrome.tabs.remove(candidate.id);
          closedCount++;
        }
      } catch {
        // The user may close or navigate tabs while grouping is in progress.
      }
    }
  }

  return closedCount;
}

/**
 * Filter valid groupable tabs from window
 * Pinned tabs and internal browser pages cannot be grouped by Chrome tabGroups API.
 */
export function getGroupableTabs(tabs) {
  const UNGROUPABLE_PREFIXES = [
    'chrome://', 'chrome-devtools://', 'chrome-extension://',
    'about:', 'edge://', 'brave://', 'devtools://'
  ];
  return tabs
    .map(t => ({ ...t, url: t.url || t.pendingUrl || '' }))
    .filter(t =>
      !t.pinned &&
      t.url &&
      !UNGROUPABLE_PREFIXES.some(p => t.url.startsWith(p))
    );
}

/** Saved settings with the engine resolved: a value that names no engine runs as Offline smart mode. */
export async function loadGroupingSettings() {
  const settings = await loadSettings();
  return { ...settings, provider: resolveProvider(settings.provider) };
}

export function usesCloudEngine(settings = {}) {
  const provider = resolveProvider(settings.provider);
  if (provider === 'ollama') return !isLoopbackUrl(settings.ollamaBaseUrl || PROVIDER_CATALOG.ollama.baseUrl);
  return !isLocalEngine(provider);
}

/** Engine, strategy, and the cache scope that results for them are stored under. */
export function getRunScope(settings) {
  const provider = resolveProvider(settings.provider);
  const requestedModel = modelForSettings(settings);
  const groupingStrategy = settings.groupingStrategy === 'site' ? 'site' : 'task';
  const savedReasoningEffort = provider === 'gemini_api'
    ? settings.geminiReasoningEffort
    : settings[providerSettingKey(provider, 'reasoningEffort')];
  const effectiveReasoningEffort = groupingStrategy === 'task'
    ? getEffectiveReasoningEffort(provider, requestedModel, savedReasoningEffort)
    : null;
  // A plan request ignores the saved effort (planReasoningEffort), so its
  // results are scoped by the effort it sends, not the saved one.
  const planEngine = usesPlanRequest(settings);
  const scopeSettings = planEngine
    ? { ...settings, [provider === 'gemini_api' ? 'geminiReasoningEffort' : providerSettingKey(provider, 'reasoningEffort')]: planReasoningEffort(provider, requestedModel) ?? undefined }
    : settings;
  return {
    provider,
    requestedModel,
    groupingStrategy,
    effectiveReasoningEffort,
    labelScope: labelCacheScope(settings),
    // Offline smart mode results come from the local engine (local-v1), not
    // the rule cascade cached under 'refined' before it.
    cacheScope: `${PROMPT_VERSION}:${groupingStrategy}:${labelCacheScope(scopeSettings)}:${planEngine ? 'plan'
      : provider === 'offline' ? 'local-v1'
        : 'refined'}`
  };
}

/** Engines whose click sends one plan request for the window: cloud engines and Ollama, By task. */
export function usesPlanRequest(settings = {}) {
  return settings?.groupingStrategy !== 'site' && isCloudProvider(resolveProvider(settings?.provider));
}

/** Engines that run on this device: offline smart mode and Ollama. */
export function isLocalEngine(provider) {
  const id = resolveProvider(provider);
  return id === 'offline' || PROVIDER_CATALOG[id]?.local === true;
}

/**
 * One deadline for a click. remaining() counts down to it; abortAt(ms) returns
 * a signal that aborts ms before it. dispose() clears pending timers.
 */
export function createClickBudget(totalMs, now = () => performance.now()) {
  const deadline = now() + Math.max(0, Number(totalMs) || 0);
  const timers = new Set();
  return {
    deadline,
    remaining() {
      return Math.max(0, deadline - now());
    },
    abortAt(msBeforeDeadline = 0) {
      const controller = new AbortController();
      const reason = () => new Error('The click budget ran out');
      const wait = deadline - Math.max(0, Number(msBeforeDeadline) || 0) - now();
      if (wait <= 0) {
        controller.abort(reason());
        return controller.signal;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        controller.abort(reason());
      }, wait);
      timers.add(timer);
      return controller.signal;
    },
    dispose() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    }
  };
}

/**
 * Settle with the promise's outcome, or with 'timeout' after ms (or at
 * `cutoffAt`), never rejecting. With `strict`, an outcome that settles after the cutoff is a
 * timeout too, even when a busy event loop has not run the timer yet.
 */
function settleWithin(promise, ms, { strict = false, cutoffAt = null } = {}) {
  // `cutoffAt` is a fixed performance.now() timestamp: the cutoff then cannot
  // move when the caller is slow to get here.
  const cutoff = Number.isFinite(cutoffAt) ? cutoffAt : performance.now() + Math.max(0, Number(ms) || 0);
  const wait = Math.max(0, cutoff - performance.now());
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ state: 'timeout' }), wait);
    const settle = outcome => {
      clearTimeout(timer);
      resolve(strict && performance.now() > cutoff ? { state: 'timeout' } : outcome);
    };
    Promise.resolve(promise).then(value => settle({ state: 'fulfilled', value }), reason => settle({ state: 'rejected', reason }));
  });
}

/**
 * The embedding table if it is ready within `ms` (0: only if it has already
 * loaded), else null. `tableLoad` is loadTable()'s promise, started when the
 * click started; it never rejects.
 */
async function tableWithin(tableLoad, ms) {
  if (!tableLoad) return null;
  const outcome = await settleWithin(tableLoad, Math.max(0, ms));
  return outcome.state === 'fulfilled' ? outcome.value || null : null;
}

/**
 * Vectors for the local engine from the table: title plus URL words at 0.5,
 * idf on (as measured in eval/product-local.mjs). null without a table.
 */
function localVectors(table, tabs) {
  if (!table || tabs.length < 2) return null;
  try {
    const rows = embedWindow(table, tabs.map(tab => [String(tab.title || ''), urlWords(tab.url || tab.pendingUrl || '')]), { idf: true, urlWeight: 0.5 });
    return new Map(tabs.map((tab, index) => [tab.id, rows[index]]));
  } catch {
    return null;
  }
}

/** Whether a click may show the local engine's result (Offline, or a plan engine's stand-in). */
function usesLocalEngine(settings) {
  const { provider, groupingStrategy } = getRunScope(settings);
  return groupingStrategy === 'task' && (provider === 'offline' || usesPlanRequest(settings));
}

/**
 * Groups the planner must not change: explicit manual rules first (skipped in
 * incognito, as rules are stored data), then Socials for the remaining social
 * sites. Returns the locked groups and the pool of tabs left to label.
 */
export async function buildLockedGroups(tabs, { incognito = false } = {}) {
  const list = tabs || [];
  const locked = [];
  const claimed = new Set();

  if (!incognito) {
    const { matchedGroups } = await LearningCache.classifyExplicit(list);
    for (const group of matchedGroups || []) {
      const tabIds = group.tabs.map(tab => tab.id).filter(id => !claimed.has(id));
      if (tabIds.length === 0) continue;
      tabIds.forEach(id => claimed.add(id));
      locked.push({ name: group.name, color: group.color || 'blue', tabIds, kind: 'rule', locked: true });
    }
  }

  const socialIds = list
    .filter(tab => !claimed.has(tab.id) && isSocialSite(tab.url || tab.pendingUrl || ''))
    .map(tab => tab.id);
  if (socialIds.length > 0) {
    socialIds.forEach(id => claimed.add(id));
    // A rule the user named Socials takes the social tabs as well.
    const rule = locked.find(group => group.name.toLowerCase() === 'socials');
    if (rule) rule.tabIds.push(...socialIds);
    else locked.push({ name: 'Socials', color: 'blue', tabIds: socialIds, kind: 'social', locked: true });
  }

  return { locked, pool: list.filter(tab => !claimed.has(tab.id)) };
}

function isLockedPlanGroup(group) {
  return group?.locked === true || group?.kind === 'rule' || group?.kind === 'social';
}

function isReviewPlanGroup(group) {
  return group?.kind === 'review' || String(group?.name || '').toLowerCase() === REVIEW_GROUP_NAME.toLowerCase();
}

/**
 * The Offline smart mode click: the local engine plans the whole pool. No
 * request, and nothing is cached by tab. Pure of Chrome group changes.
 */
async function groupOffline(groupableTabs, locked, settings, {
  budget = null,
  trace = noopTrace,
  windowId = null,
  incognito = false,
  // loadTable()'s promise, started with the click; null for title words only.
  tableLoad = null
} = {}) {
  const scope = labelCacheScope(settings);
  const clickBudget = budget || createClickBudget(CLICK_BUDGET_MS);
  const lockedIds = new Set((locked || []).flatMap(group => group.tabIds || []));
  const pool = groupableTabs.filter(tab => !lockedIds.has(tab.id));
  const tabsById = new Map(groupableTabs.map(tab => [tab.id, tab]));
  const labelSources = { cache: 0, model: 0, siteAffinity: 0, site: 0, lexicon: 0, tokenAttach: 0, review: 0 };
  const qualityFlags = [];

  // Fingerprints so user renames stick. Incognito reads and keeps nothing.
  const fingerprintById = incognito ? new Map() : await fingerprintsOf(pool);
  const memory = incognito ? null : await PlanMemory.read({ scope });
  const vectors = localVectors(await tableWithin(tableLoad, clickBudget.remaining() - APPLY_RESERVE_MS), pool);
  const local = planLocally(pool, { locked, tabsById, vectors, memory, fingerprintById });
  // Locked groups fill every slot: as on the plan path, the other tabs get
  // no group and are reported, never an eleventh group.
  const lockedCount = (locked || []).filter(group => (group?.tabIds || []).length > 0).length;
  const noFreeSlot = lockedCount >= MAX_GROUPS && pool.length > 0;
  if (noFreeSlot) qualityFlags.push('no_free_slot');
  labelSources.review = noFreeSlot ? 0 : local.unassigned.length;
  trace.mark('planned', { groups: local.groups.length, local: true });
  return {
    groups: noFreeSlot ? local.groups.filter(isLockedPlanGroup) : local.groups,
    unplacedTabIds: noFreeSlot ? pool.map(tab => tab.id) : [],
    source: 'offline',
    meta: null,
    labelSources,
    modelCalls: {},
    deadlineHit: false,
    fallbackCode: null,
    fallbackUsed: false,
    fallbackReason: null,
    plan: null,
    localEngine: true,
    localEmbedding: vectors ? 'table' : 'words',
    qualityFlags,
    windowId
  };
}

/**
 * The local result with no provider request: the local engine over the pool
 * (src/local-engine.js), locked groups first and Review Later last, with
 * remembered user renames. Used when a plan is late, fails or is not worth
 * sending, and in incognito. With the embedding table, title words plus vectors.
 */
function placeLocally(pool, groupableTabs, locked, { fingerprintById, memory, table = null }) {
  const tabsById = new Map(groupableTabs.map(tab => [tab.id, tab]));
  const vectors = localVectors(table, pool);
  const local = planLocally(pool, { locked, tabsById, vectors, memory, fingerprintById });
  const labelSources = { cache: 0, model: 0, siteAffinity: 0, site: 0, lexicon: 0, tokenAttach: 0, review: local.unassigned.length };
  return { groups: local.groups, plan: null, labelSources, localEmbedding: vectors ? 'table' : 'words' };
}

/** Full title-and-address fingerprints of tabs, by tab id. */
async function fingerprintsOf(tabs) {
  const values = await Promise.all(tabs.map(fingerprintTab));
  return new Map(tabs.map((tab, index) => [tab.id, values[index]]));
}

/**
 * The model plan that upkeep counts against: each unlocked tab it covers with
 * a short digest of its title and address, and its groups without locked
 * tabs. No title or URL is kept.
 */
function planBase(groups, fingerprints, locked) {
  const lockedIds = new Set((locked || []).flatMap(group => group.tabIds || []));
  const baseGroups = groups
    .filter(group => !isLockedPlanGroup(group))
    .map(group => ({ ...group, tabIds: (group.tabIds || []).filter(id => !lockedIds.has(id)) }))
    .filter(group => group.tabIds.length > 0);
  const tabs = baseGroups.flatMap(group => group.tabIds)
    .filter(id => fingerprints.has(id))
    .map(id => [id, fingerprints.get(id).slice(0, DIGEST_CHARS)]);
  return { tabs, groups: baseGroups };
}

/**
 * Upkeep of the last model plan for a changed window, with no request. New
 * tabs are unlocked tabs the plan did not cover, or whose title or address
 * changed since. At most UPKEEP_SHARE of the unlocked tabs: plan tabs keep
 * their groups, closed tabs drop out, new tabs join a group by attachTabs
 * (title words only) or go to Review Later, and locked groups win. User
 * renames recorded since the plan carry over. Returns null when a new plan
 * is due.
 */
function planUpkeep(base, groupableTabs, locked, { fingerprints, memory, appliedIds = new Set() }) {
  if (!base || !Array.isArray(base.tabs) || !Array.isArray(base.groups)) return null;
  let lockedGroups = (locked || []).filter(group => (group.tabIds || []).length > 0);
  const lockedIds = new Set(lockedGroups.flatMap(group => group.tabIds));
  const pool = groupableTabs.filter(tab => !lockedIds.has(tab.id));
  if (pool.length === 0) return null;
  const known = new Map(base.tabs);
  const fresh = pool.filter(tab => known.get(tab.id) !== fingerprints.get(tab.id)?.slice(0, DIGEST_CHARS));
  if (fresh.length > UPKEEP_SHARE * pool.length) return null;

  const freshIds = new Set(fresh.map(tab => tab.id));
  const kept = new Set(pool.map(tab => tab.id).filter(id => !freshIds.has(id)));
  const groups = base.groups
    .map(group => ({ ...group, tabIds: group.tabIds.filter(id => kept.has(id)) }))
    .filter(group => group.tabIds.length > 0);
  const tabsById = new Map(pool.map(tab => [tab.id, tab]));
  const { placed, unplaced } = attachTabs(groups, fresh, tabsById);
  for (const [id, index] of placed) groups[index].tabIds.push(id);
  // When the cap binds, the plan's groups and the rule or Socials groups the
  // last result placed keep their slots; a rule or Socials group that would be
  // an eleventh is not made, and its tabs stay ungrouped and are reported.
  let dropped = [];
  if (lockedGroups.length + groups.length > MAX_GROUPS) {
    const placedBefore = group => group.tabIds.some(id => appliedIds.has(id));
    const ordered = [...lockedGroups.filter(placedBefore), ...lockedGroups.filter(group => !placedBefore(group))];
    const room = Math.max(0, MAX_GROUPS - groups.length);
    lockedGroups = ordered.slice(0, room);
    dropped = ordered.slice(room).flatMap(group => group.tabIds);
  }
  // Unmatched new tabs go to Review Later; with no free slot for a new Review
  // Later they stay ungrouped and are reported, and no request is sent.
  let loose = [];
  if (unplaced.length > 0) {
    let review = groups.find(isReviewPlanGroup);
    if (!review && lockedGroups.length + groups.length < MAX_GROUPS) {
      review = { name: REVIEW_GROUP_NAME, color: 'grey', tabIds: [], key: 'review', keys: ['review'], dominant: null, kind: 'review', nameSource: 'deterministic' };
      groups.push(review);
    }
    if (review) review.tabIds.push(...unplaced);
    else loose = [...unplaced];
  }
  const userMemory = memory ? { names: (memory.names || []).filter(record => record?.s === 'user') } : null;
  const named = transferNames(groups, userMemory, { tabsById, fingerprintById: fingerprints });
  const lockedOut = lockedGroups.map(group => ({ ...group, tabIds: [...group.tabIds], locked: true }));
  return {
    groups: ensureUniqueNames([...lockedOut, ...named], [], { tabsById: new Map(groupableTabs.map(tab => [tab.id, tab])), joinLocked: false }),
    attached: placed.size,
    review: unplaced.length - loose.length,
    unplaced: [...loose, ...dropped],
    fresh: fresh.length,
    freshIds: [...freshIds]
  };
}

/**
 * Upkeep on the strip as it is. When the stored plan's groups are on the
 * strip (matched to live groups by member overlap), only the new tabs that
 * are still ungrouped are placed: each joins the live group matching the plan
 * group attachTabs chose, or the live Review Later group (whatever the user
 * named it), or a new Review Later group when none is on the strip and a slot
 * is free. No other tab moves, no group is recreated or renamed. Returns null
 * only when the strip has no tab group at all; the caller then applies the
 * groups as on any click. `reviewIds` are the stored plan's Review Later tabs.
 */
async function placeUpkeepOnStrip(groups, newIds, windowId, { reviewIds = new Set(), incognito = false, collapse = false } = {}) {
  const read = async () => getGroupableTabs((await chrome.tabs.query({ windowId })).filter(tab => Boolean(tab.incognito) === incognito));
  const ungrouped = tab => !Number.isInteger(tab.groupId) || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE;
  let live = await read();
  const liveGroups = await chrome.tabGroups.query({ windowId }).catch(() => []);
  const membersOf = new Map(liveGroups.map(group => [group.id, new Set(live.filter(tab => tab.groupId === group.id).map(tab => tab.id))]));

  // One live group per plan group, largest member overlap first.
  const pairs = [];
  groups.forEach((group, index) => {
    for (const [liveId, members] of membersOf) {
      const overlap = group.tabIds.filter(id => members.has(id)).length;
      if (overlap > 0) pairs.push({ index, liveId, overlap });
    }
  });
  pairs.sort((a, b) => b.overlap - a.overlap || a.index - b.index || a.liveId - b.liveId);
  const liveFor = new Map();
  const usedLive = new Set();
  for (const { index, liveId } of pairs) {
    if (liveFor.has(index) || usedLive.has(liveId)) continue;
    liveFor.set(index, liveId);
    usedLive.add(liveId);
  }
  // Full reapplication only on an empty strip; any group on it, even one
  // unrelated to the plan, keeps upkeep to placing new tabs.
  if (!live.some(tab => !ungrouped(tab))) return null;

  const reviewIndex = groups.findIndex(isReviewPlanGroup);
  if (reviewIndex >= 0 && !liveFor.has(reviewIndex)) {
    const review = liveGroups.find(group => !usedLive.has(group.id) && membersOf.get(group.id).size > 0
      && (String(group.title || '').toLowerCase() === REVIEW_GROUP_NAME.toLowerCase()
        || [...membersOf.get(group.id)].some(id => reviewIds.has(id))));
    if (review) {
      liveFor.set(reviewIndex, review.id);
      usedLive.add(review.id);
    }
  }

  const liveById = new Map(live.map(tab => [tab.id, tab]));
  const fresh = new Set(newIds);
  let attached = 0;
  let reviewed = 0;
  let created = 0;
  const unplaced = [];
  // Each candidate is read again just before its placement: still in this
  // window and still ungrouped, otherwise the user moved it and it stays.
  const stillLoose = async ids => (await Promise.all(ids.map(id => chrome.tabs.get(id).catch(() => null))))
    .filter(tab => tab && tab.windowId === windowId && ungrouped(tab)).map(tab => tab.id);
  for (const [index, group] of groups.entries()) {
    const candidates = group.tabIds.filter(id => fresh.has(id) && liveById.has(id) && ungrouped(liveById.get(id)));
    if (candidates.length === 0) continue;
    const ids = await stillLoose(candidates);
    if (ids.length === 0) continue;
    const liveId = liveFor.get(index);
    if (Number.isInteger(liveId)) {
      try {
        await chrome.tabs.group({ groupId: liveId, tabIds: ids });
        if (index === reviewIndex) reviewed += ids.length;
        else attached += ids.length;
      } catch (error) {
        console.warn('[Foldnex] Could not add new tabs to a live group:', error?.message);
        unplaced.push(...ids);
      }
    } else if (index === reviewIndex && liveGroups.filter(item => membersOf.get(item.id).size > 0).length < MAX_GROUPS) {
      const made = await placeGroups([{ ...group, tabIds: ids }], windowId, { incognito, collapse });
      created += made.created;
      if (made.created > 0) reviewed += ids.length;
      else unplaced.push(...ids);
    } else {
      // Its plan group is not on the strip, or no slot is free: left ungrouped.
      unplaced.push(...ids);
    }
  }

  // The result is the strip as it now is: each live group with the plan
  // group it matches (named as the user sees it), and groups the user made.
  live = await read();
  const planFor = new Map([...liveFor].map(([index, liveId]) => [liveId, groups[index]]));
  const titles = new Map((await chrome.tabGroups.query({ windowId }).catch(() => [])).map(group => [group.id, group]));
  const placed = [];
  for (const liveId of new Set(live.filter(tab => !ungrouped(tab)).map(tab => tab.groupId))) {
    const tabIds = live.filter(tab => tab.groupId === liveId).map(tab => tab.id);
    const shown = titles.get(liveId);
    const plan = planFor.get(liveId) || groups.find(group => isReviewPlanGroup(group) && tabIds.some(id => group.tabIds.includes(id)));
    const name = String(shown?.title || '').trim();
    placed.push(plan
      ? { ...plan, name: name || plan.name, color: shown?.color || plan.color, tabIds }
      : { name, color: shown?.color || 'grey', tabIds, kind: 'folder', nameSource: 'user' });
  }
  return { groups: placed, created, attached, review: reviewed, unplaced };
}

// Per window: the plan request that missed its click's deadline, until it
// settles into an offer or is dropped. Keyed by the window; the entry holds
// the tab set, engine scope and locked partition the request was made for.
const latePlans = new Map();

/**
 * Stop pending plan work for a window (closed, ungrouped, or superseded by an
 * applied plan): a request not yet dispatched is not sent, and one in flight
 * is aborted and offers nothing.
 */
export function cancelPlanWork(windowId) {
  const entry = latePlans.get(windowId);
  if (entry) {
    entry.cancelled = true;
    entry.abort?.();
  }
  latePlans.delete(windowId);
}

/** A local key for the locked groups (rules and Socials) a plan was made around. */
export function lockedPartitionKey(locked) {
  const parts = (locked || [])
    .filter(group => (group?.tabIds || []).length > 0)
    .map(group => [String(group.name || '').toLowerCase(), [...group.tabIds].sort((a, b) => a - b)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return hashToken(JSON.stringify(parts));
}

/** Tab-group membership of the groupable tabs: [tabId, groupId] pairs by tab ID. */
function readMembership(tabs) {
  return (tabs || [])
    .map(tab => [tab.id, Number.isInteger(tab.groupId) ? tab.groupId : -1])
    .sort((a, b) => a[0] - b[0]);
}

function sameMembership(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

/** The identity a plan is bound to: tab set, engine scope and locked partition. */
async function planBinding(groupableTabs, locked, cacheScope) {
  const signature = await tabSetSignature(groupableTabs);
  const lockedKey = lockedPartitionKey(locked);
  return { signature, scope: cacheScope, locked: lockedKey, key: `${signature}|${cacheScope}|${lockedKey}` };
}

/** A window's tabs, or null for a private or empty window. Read before any store. */
async function readWindowTabs(windowId) {
  if (!Number.isInteger(windowId)) return null;
  const tabs = await chrome.tabs.query({ windowId });
  if (!tabs?.length || tabs.some(tab => tab.incognito)) return null;
  return tabs;
}

/**
 * Whether a stored offer still fits the window and the current settings: the
 * same tab set (IDs, full URLs, titles), a plan engine with the same scope,
 * the same locked partition and the tab-group membership left by the local
 * result.
 */
async function offerStillValid(offer, groupable, settings) {
  if (!offer || !groupable?.length || !usesPlanRequest(settings)) return false;
  if (!offer.scope || offer.scope !== getRunScope(settings).cacheScope) return false;
  if (await tabSetSignature(groupable) !== offer.signature) return false;
  const { locked } = await buildLockedGroups(groupable);
  if (lockedPartitionKey(locked) !== offer.locked) return false;
  return sameMembership(readMembership(groupable), offer.membership);
}

/**
 * The click path of cloud engines and Ollama: one plan request for the pool
 * (the groupable tabs minus the locked groups), validated by enforcePlan and
 * applied once if it is back within the budget. The deadline race starts at
 * dispatch. Otherwise the local placement is applied; a plan that lands later
 * is validated against the rows it was sent with, checked against the live
 * window, stored as an offer and announced. A private window never sends a
 * request (D40); with no free folder slot nothing is sent either. Nothing
 * here sends label, naming or consolidation requests or leaves tabs provisional.
 * `latePlan.setBaseline(membership)` must be called once the local result is
 * on the strip; the offer waits for it.
 */
export async function groupByPlan(groupableTabs, locked, settings, {
  budget = null,
  trace = noopTrace,
  windowId = null,
  incognito = false,
  provider = settings?.provider,
  epoch = null,
  scope = null,
  cacheScope = '',
  binding = null,
  onPlanOffer = null,
  onPlanFailed = null,
  // loadTable()'s promise, started with the click; null for title words only.
  tableLoad = null
} = {}) {
  const origin = epoch ?? await readResetEpoch();
  const labelScope = scope ?? labelCacheScope(settings);
  const clickBudget = budget || createClickBudget(PLAN_CLICK_BUDGET_MS);
  const lockedGroups = (locked || []).filter(group => (group.tabIds || []).length > 0);
  const lockedIds = new Set(lockedGroups.flatMap(group => group.tabIds));
  const pool = groupableTabs.filter(tab => !lockedIds.has(tab.id));
  const tabsById = new Map(groupableTabs.map(tab => [tab.id, tab]));
  const limit = MAX_GROUPS - lockedGroups.length;
  const modelCalls = { plan: 0 };
  const qualityFlags = [];
  const { requestedModel } = getRunScope(settings);
  const planEffort = planReasoningEffort(provider, requestedModel);

  // The request goes first; local work runs while it is in flight.
  let request = null;
  let raced = null;
  // A request may land late, unless its late work is cancelled (cancelPlanWork).
  const requestAbort = new AbortController();
  if (!incognito && pool.length >= 2 && limit >= 1) {
    request = planWindowWithCloud(pool, limit, settings, {
      trace,
      recordUsage: true,
      onDispatch: () => { modelCalls.plan++; },
      signal: requestAbort.signal
    });
    request.catch(() => {});
    // The deadline race starts at dispatch, so an answer that lands after the
    // deadline stays late however long the local work below takes, or a busy
    // event loop delays the timer.
    raced = settleWithin(request, 0, { strict: true, cutoffAt: clickBudget.deadline - APPLY_RESERVE_MS });
  }

  const fingerprintById = incognito ? new Map() : await fingerprintsOf(pool);
  const memory = incognito ? null : await PlanMemory.read({ scope: labelScope });
  const enforce = json => enforcePlan(json, pool, { locked: lockedGroups, tabsById, memory, fingerprintById });

  const outcome = raced ? await raced : { state: 'skipped' };
  // The local result, with the table when it is ready in time. Only a failed
  // or unsent request may wait for it, until the apply reserve; a late plan's
  // fallback (and an answer that is back) takes it only if it has already loaded.
  const tableWait = outcome.state === 'rejected' || outcome.state === 'skipped' ? clickBudget.remaining() - APPLY_RESERVE_MS : 0;
  const local = placeLocally(pool, groupableTabs, locked, { fingerprintById, memory, table: await tableWithin(tableLoad, tableWait) });
  const base = {
    groups: local.groups,
    source: 'local',
    meta: null,
    unplacedTabIds: [],
    labelSources: local.labelSources,
    modelCalls,
    deadlineHit: false,
    fallbackCode: null,
    fallbackUsed: false,
    fallbackReason: null,
    plan: local.plan,
    localEngine: true,
    localEmbedding: local.localEmbedding,
    planApplied: false,
    planReviewOnly: false,
    latePlan: null,
    qualityFlags,
    windowId
  };
  const planMeta = (extra = {}) => ({ provider, model: requestedModel, reasoningEffort: planEffort, usage: null, latencyMs: 0, calls: modelCalls.plan, ...extra });
  const failed = reason => {
    const fallback = { ...classifyProviderFailure(reason), used: true };
    return {
      ...base,
      source: 'offline-fallback',
      meta: planMeta({ reasoningEffort: modelCalls.plan > 0 ? planEffort : null }),
      fallbackCode: fallback.code,
      fallbackUsed: true,
      fallbackReason: fallback.detail
    };
  };

  if (outcome.state === 'skipped') {
    if (limit >= 1 || pool.length === 0) return base;
    // Locked groups fill every slot: the unlocked tabs get no group, so the
    // total stays within MAX_GROUPS, and the result says so.
    qualityFlags.push('no_free_slot');
    return {
      ...base,
      groups: local.groups.filter(group => isLockedPlanGroup(group) || lockedGroups.some(lockedGroup => lockedGroup.name === group.name)),
      unplacedTabIds: pool.map(tab => tab.id)
    };
  }
  if (outcome.state === 'rejected') return failed(outcome.reason);
  if (outcome.state === 'fulfilled') {
    const enforced = enforce(outcome.value?.json);
    trace.mark('plan_applied', { folders: enforced.folders, unassigned: enforced.unassigned.length, dropped: enforced.dropped });
    if (enforced.folders === 0 && enforced.reviewOnly) {
      // A valid answer, but one Review Later group for the whole window is a
      // worse cleanup than the local one: keep the local result, truthfully.
      qualityFlags.push('plan_review_only');
      return { ...base, meta: outcome.value?.meta || planMeta(), planReviewOnly: true };
    }
    if (enforced.folders === 0) return { ...failed(new Error('The provider returned no usable plan')), meta: outcome.value?.meta || null };
    if (enforced.dropped > 0) qualityFlags.push('plan_over_limit');
    return {
      ...base,
      groups: enforced.groups,
      source: 'cloud-plan',
      meta: outcome.value.meta,
      labelSources: { cache: 0, model: pool.length, siteAffinity: 0, site: 0, lexicon: 0, tokenAttach: 0, review: enforced.unassigned.length },
      plan: null,
      localEngine: false,
      localEmbedding: null,
      planApplied: true
    };
  }

  // Late: the local result now; the plan, if it lands, is only ever offered.
  trace.mark('plan_deadline', { tabs: pool.length });
  qualityFlags.push('plan_timeout');
  let latePlan = null;
  if (Number.isInteger(windowId) && binding) {
    const entry = { key: binding.key, cancelled: false, abort: () => requestAbort.abort(new Error('Plan work cancelled')) };
    latePlans.set(windowId, entry);
    let setBaseline = () => {};
    const baseline = new Promise(resolve => { setBaseline = resolve; });
    let baselineSet = false;
    // The first call counts. Without a membership (the click failed after the
    // deadline) nothing can be offered: the entry goes at once, so the next
    // click on the window runs normally.
    latePlan = {
      setBaseline: membership => {
        if (baselineSet) return;
        baselineSet = true;
        if (!membership) {
          entry.cancelled = true;
          if (latePlans.get(windowId) === entry) latePlans.delete(windowId);
        }
        setBaseline(membership || null);
      }
    };
    const current = () => !entry.cancelled && latePlans.get(windowId) === entry;
    const finish = () => {
      if (latePlans.get(windowId) === entry) latePlans.delete(windowId);
    };
    // Anything but an announced offer tells the popup the plan is not coming,
    // unless the work was cancelled (window closed or a plan applied since).
    const drop = () => {
      const notify = current();
      finish();
      if (notify) onPlanFailed?.(windowId);
    };
    request.then(async value => {
      const enforced = enforce(value?.json);
      if (enforced.folders === 0) return drop();
      const membership = await baseline;
      if (!current()) return finish();
      if (!membership) return drop();
      const live = await readWindowTabs(windowId);
      const groupable = live ? getGroupableTabs(live) : null;
      if (!groupable || await readResetEpoch() !== origin || await tabSetSignature(groupable) !== binding.signature) return drop();
      if (!current()) return finish();
      const stored = await PlanOfferStore.put(windowId, {
        signature: binding.signature,
        scope: cacheScope,
        locked: binding.locked,
        membership,
        groups: enforced.groups
      }, { epoch: origin });
      if (!current()) {
        if (stored) await PlanOfferStore.remove(windowId);
        return finish();
      }
      if (stored && await getPlanOffer(windowId, { verify: true, settings })) {
        finish();
        onPlanOffer?.(windowId);
      } else {
        drop();
      }
    }, drop).catch(drop);
  }
  return {
    ...base,
    source: 'plan-pending',
    deadlineHit: true,
    latePlan,
    meta: planMeta()
  };
}

/**
 * The offer waiting for a window, or null. A private window reads nothing.
 * With `verify`, an offer that no longer fits the window or the settings
 * (`settings`, else the saved ones) is dropped and null returned.
 * @returns {Promise<{windowId: number, groups: number, createdAt: number}|null>}
 */
export async function getPlanOffer(windowId, { verify = false, settings = null } = {}) {
  const tabs = await readWindowTabs(windowId);
  if (!tabs) return null;
  const offer = await PlanOfferStore.get(windowId);
  if (!offer) return null;
  if (verify && !await offerStillValid(offer, getGroupableTabs(tabs), settings || await loadGroupingSettings())) {
    await PlanOfferStore.remove(offer.windowId);
    return null;
  }
  return { windowId: offer.windowId, groups: offer.groups.length, createdAt: offer.createdAt };
}

/**
 * Apply the stored late plan for a window, on the user's word. It is applied
 * only while it still fits the window and the settings (offerStillValid),
 * checked again with the reset epoch just before the strip changes, using
 * that snapshot. The offer is consumed and the caches written only after
 * Chrome took every group. A changed window drops the offer. Callers hold
 * the worker's grouping lock.
 */
export async function applyPlanOffer(windowId, settings = null) {
  const none = { success: false, reason: 'none', message: 'No late grouping is waiting for this window.' };
  const tabs = await readWindowTabs(windowId);
  if (!tabs) return none;
  const offer = await PlanOfferStore.get(windowId);
  if (!offer) return none;
  const effectiveSettings = settings || await loadGroupingSettings();
  const changed = async () => {
    await PlanOfferStore.remove(offer.windowId);
    return { success: false, reason: 'changed', message: 'The window changed, so the late grouping was dropped.' };
  };
  const groupable = getGroupableTabs(tabs);
  if (!await offerStillValid(offer, groupable, effectiveSettings)) return changed();
  const startedAt = performance.now();
  const epoch = offer.g;

  let groups = offer.groups.map(group => ({ ...group, tabIds: [...group.tabIds] }));
  const before = groups;
  const renamed = await LearningCache.applyGroupPreferences(before, groupable);
  groups = mergeGroupsByName(renamed.map((group, index) => (
    group.name !== before[index]?.name ? { ...group, nameSource: 'user' } : group
  )));

  // Immediately before the strip changes: the same window, then the same
  // epoch, read after the last policy read.
  const liveTabs = await readWindowTabs(offer.windowId);
  const live = liveTabs ? getGroupableTabs(liveTabs) : null;
  if (!await offerStillValid(offer, live, effectiveSettings) || await readResetEpoch() !== epoch) return changed();
  cancelPlanWork(offer.windowId);
  const { created, failed } = await placeGroups(groups, offer.windowId, {
    incognito: false,
    collapse: Boolean(effectiveSettings.collapseGroupsOnCreation),
    liveTabs
  });
  if (failed > 0) {
    // The strip is unchanged only if nothing was created; then the offer stays.
    if (created > 0) await PlanOfferStore.remove(offer.windowId);
    return {
      success: false,
      reason: 'failed',
      message: 'Chrome refused the late grouping, so it was not applied.',
      groupsCreated: created,
      windowId: offer.windowId
    };
  }
  await PlanOfferStore.remove(offer.windowId);
  const { locked: liveLocked } = await buildLockedGroups(live);
  await WindowPlanStore.put(offer.windowId, {
    K: MAX_GROUPS, signature: planSignature(groups), groups,
    applied: { tabSet: offer.signature, scope: offer.scope, locked: offer.locked, groups },
    base: { scope: offer.scope, ...planBase(groups, await fingerprintsOf(live), liveLocked) }
  }, { epoch });
  await ExactResultCache.put(await ExactResultCache.makeContext(live, offer.scope), groups, { epoch });
  const { provider, requestedModel } = getRunScope(effectiveSettings);
  const nameSources = countNameSources(groups);
  await recordRun({
    timestamp: Date.now(),
    groupsCreated: created,
    tabsGrouped: live.length,
    duplicateTabsClosed: 0,
    strategy: 'task',
    provider,
    providerMode: usesCloudEngine(effectiveSettings) ? 'cloud' : 'local',
    model: requestedModel,
    reasoningEffort: null,
    source: 'plan-offer',
    promptVersion: PROMPT_VERSION,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: null,
    latencyMs: Math.round(performance.now() - startedAt),
    providerLatencyMs: 0,
    qualityFlags: [],
    fallbackCode: null,
    fallbackDetail: null,
    groupCeiling: MAX_GROUPS,
    labelSources: { cache: 0, model: 0, siteAffinity: 0, site: 0, lexicon: 0, tokenAttach: 0, review: 0 },
    modelCalls: { plan: 0 },
    nameSources,
    deadlineHit: false,
    budgetMs: 0,
    groups: groups.map(group => ({ name: group.name, size: group.tabIds?.length || 0 }))
  });
  return {
    success: true,
    source: 'plan-offer',
    message: `Applied the late grouping: ${created} groups.`,
    groupsCreated: created,
    totalTabs: live.length,
    strategy: 'task',
    provider,
    groups,
    nameSources,
    windowId: offer.windowId,
    incognito: false
  };
}

/**
 * C4 (part): an exact-cache hit keeps its membership but takes the user
 * renames PlanMemory learned since it was stored: a cached group whose tabs'
 * fingerprints cover a rename's tabs takes that name and colour, matched as a
 * set (transferNames' 'set' rule), unless another group already holds the
 * name. No model call.
 */
async function overlayRememberedNames(groups, tabs, context = null, scope = null) {
  const memory = await PlanMemory.read({ scope });
  const userMemory = { names: memory.names.filter(record => record?.s === 'user') };
  if (userMemory.names.length === 0) return groups;
  const tabsById = new Map(tabs.map(tab => [tab.id, tab]));
  const fingerprintById = new Map((context?.entries || []).map(entry => [entry.tab.id, entry.fingerprint]));
  return transferNames(groups, userMemory, { tabsById, fingerprintById, userMatch: 'set' });
}

function countNameSources(groups) {
  const counts = { user: 0, memory: 0, model: 0, deterministic: 0 };
  for (const group of groups) {
    const source = String(group.nameSource || '');
    if (source === 'user' || source === 'memory-user') counts.user++;
    else if (source === 'memory-model') counts.memory++;
    else if (source === 'model') counts.model++;
    else counts.deterministic++;
  }
  return counts;
}

/**
 * Execute grouping for the given window (or active window). Task mode runs
 * within one click budget (CLICK_BUDGET_MS by default).
 */
export async function executeTabGrouping(windowId, settings, { budgetMs = null, onPlanOffer = null, onPlanFailed = null } = {}) {
  const effectiveSettings = settings || await loadGroupingSettings();
  const totalMs = Number.isFinite(budgetMs)
    ? budgetMs
    : usesPlanRequest(effectiveSettings) ? PLAN_CLICK_BUDGET_MS : CLICK_BUDGET_MS;
  const budget = createClickBudget(totalMs);
  const pending = { latePlan: null };
  // Start reading the embedding table now; the local result uses it only if
  // it is ready in time. Reading a packaged file stores nothing.
  const tableLoad = usesLocalEngine(effectiveSettings) ? loadTable() : null;
  try {
    return await groupWindow(windowId, effectiveSettings, budget, totalMs, { onPlanOffer, onPlanFailed, pending, tableLoad });
  } finally {
    budget.dispose();
    // Whatever threw after the deadline, the late plan is settled: no window stays pending.
    pending.latePlan?.setBaseline(null);
  }
}

async function groupWindow(windowId, settings, budget, budgetMs, { onPlanOffer = null, onPlanFailed = null, pending = {}, tableLoad = null } = {}) {
  const epoch = await readResetEpoch();
  const runStartedAt = performance.now();
  // 1. Resolve and lock explicit target window
  let targetWindowId = windowId;
  if (!targetWindowId) {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    targetWindowId = activeTab?.windowId;
  }

  const allTabs = await chrome.tabs.query(targetWindowId ? { windowId: targetWindowId } : { currentWindow: true });
  if (!allTabs || allTabs.length === 0) {
    return {
      success: false,
      message: 'No tabs found in target window',
      groupsCreated: 0,
      totalTabs: 0
    };
  }

  const resolvedWindowId = allTabs[0].windowId;
  const isIncognitoWindow = Boolean(allTabs[0].incognito);

  // Enforce single window & matching incognito boundary
  const boundedTabs = allTabs.filter(t => t.windowId === resolvedWindowId && Boolean(t.incognito) === isIncognitoWindow);
  // Incognito runs record nothing, not even development traces.
  const trace = isIncognitoWindow ? noopTrace : createTrace({ tabsInWindow: boundedTabs.length });
  trace.mark('start');
  const duplicateTabsClosed = await eliminateDuplicateTabs(boundedTabs, resolvedWindowId);
  trace.mark('duplicates_closed', { closed: duplicateTabsClosed });

  // Refresh after closing duplicates so AI, learning, and grouping see only
  // the canonical copies and current tab state.
  const tabsAfterDeduplication = await chrome.tabs.query({ windowId: resolvedWindowId });
  const groupableTabs = getGroupableTabs(
    tabsAfterDeduplication.filter(t => Boolean(t.incognito) === isIncognitoWindow)
  );

  if (groupableTabs.length <= 1) {
    return {
      success: true,
      message: 'Not enough tabs to group (minimum 2 unpinned tabs required)',
      groupsCreated: 0,
      totalTabs: groupableTabs.length,
      duplicateTabsClosed
    };
  }

  const savedSettings = settings || await loadGroupingSettings();
  // A private window never sends anything: every engine runs as Offline smart
  // mode there, so no tab data leaves the browser (D40).
  const effectiveSettings = isIncognitoWindow ? { ...savedSettings, provider: 'offline' } : savedSettings;
  let fallbackUsed = false;
  let fallbackReason = null;
  let fallbackCode = null;
  let resultSource = 'unknown';
  let aiMeta = null;
  let qualityIssues = [];
  let qualityCodes = [];
  let deadlineHit = false;
  let labelSources = { cache: 0, model: 0, siteAffinity: 0, site: 0, lexicon: 0, tokenAttach: 0, review: 0 };
  let modelCalls = {};
  let planForStore = null;
  let exactCacheToWrite = null;
  let planApplied = false;
  let planReviewOnly = false;
  let unplacedTabIds = [];
  let latePlan = null;
  let binding = null;
  let localEmbedding = null;
  let fingerprints = null;
  let storedApplied = null;
  let storedBase = null;
  let upkeep = null;

  if (!isIncognitoWindow) await LearningCache.ensureSchema();
  const { provider, requestedModel, groupingStrategy, effectiveReasoningEffort, cacheScope, labelScope } = getRunScope(effectiveSettings);
  const n = groupableTabs.length;
  const ceiling = groupCeiling(n);
  const planEngine = usesPlanRequest(effectiveSettings);
  const planEffort = planEngine ? planReasoningEffort(provider, requestedModel) : null;

  console.log(`[Foldnex] Starting grouping for ${n} tabs in window ${resolvedWindowId}...`);
  trace.mark('settings_ready', { groupable: n, provider, strategy: groupingStrategy, ceiling });

  let finalGroups = [];

  if (groupingStrategy === 'site') {
    finalGroups = clusterTabsBySite(groupableTabs);
    resultSource = 'site-category';
    console.log(`[Foldnex] Grouped ${n} tabs locally by site category.`);

    let explicitGroups = [];
    if (!isIncognitoWindow) {
      finalGroups = await LearningCache.applyGroupPreferences(finalGroups, groupableTabs);
      ({ matchedGroups: explicitGroups } = await LearningCache.classifyExplicit(groupableTabs));
      finalGroups = mergeExplicitGroups(finalGroups, explicitGroups);
    }
    if (APPLY_CEILING_TO_SITE_MODE) {
      const tabsById = new Map(groupableTabs.map(tab => [tab.id, tab]));
      finalGroups = enforceGroupCeiling(finalGroups, {
        ceiling,
        protectedNames: explicitGroups.map(group => group.name),
        dominantOf: group => categoryFromSite(tabsById.get(group.tabIds?.[0])?.url)
      });
    }
  } else {
    // C3: explicit rules, then Socials, stay exactly as they are.
    const { locked } = await buildLockedGroups(groupableTabs, { incognito: isIncognitoWindow });
    const lockedNames = locked.map(group => group.name);

    // C4: an unchanged window reuses its whole result.
    let exactCacheContext = null;
    if (!isIncognitoWindow) {
      const cached = await ExactResultCache.get(groupableTabs, cacheScope);
      exactCacheContext = cached.context;
      if (cached.groups?.length) {
        finalGroups = await overlayRememberedNames(cached.groups, groupableTabs, cached.context, labelScope);
        resultSource = 'exact-cache';
        console.log(`[Foldnex] Reused an exact result for ${n} unchanged tabs.`);
      }
    }

    if (planEngine && !isIncognitoWindow) {
      binding = await planBinding(groupableTabs, locked, cacheScope);
      fingerprints = await fingerprintsOf(groupableTabs);
      const record = await WindowPlanStore.get(resolvedWindowId);
      storedApplied = record?.applied || null;
      // The last model plan for this engine scope, whatever has been applied since.
      storedBase = record?.base?.scope === binding.scope ? record.base : null;
    }

    // C4 for plan engines: the plan applied to this unchanged window (a model
    // plan or its upkeep), when the exact cache has aged out or a rename
    // cleared it. Other local results carry no binding and are never reused here.
    if (finalGroups.length === 0 && binding) {
      const applied = storedApplied;
      if (applied && applied.tabSet === binding.signature && applied.scope === binding.scope && applied.locked === binding.locked) {
        const copies = applied.groups.map(group => ({ ...group, tabIds: [...group.tabIds] }));
        finalGroups = await overlayRememberedNames(copies, groupableTabs, exactCacheContext, labelScope);
        resultSource = 'stored-plan';
        console.log(`[Foldnex] Reused the applied plan for ${n} unchanged tabs.`);
      }
    }

    const leaveStrip = (source, message, extra = {}) => ({
      success: true,
      message,
      groupsCreated: 0,
      totalTabs: n,
      duplicateTabsClosed,
      strategy: groupingStrategy,
      provider,
      source,
      planEngine: true,
      fallbackUsed: false,
      fallbackReason: null,
      fallbackCode: null,
      groups: [],
      qualityFlags: [],
      qualityCodes: [],
      deadlineHit: false,
      windowId: resolvedWindowId,
      incognito: false,
      ...extra
    });

    // A late plan waiting for this unchanged window: leave the strip as it
    // is and send nothing; the popup offers the plan.
    if (finalGroups.length === 0 && binding) {
      const offer = await PlanOfferStore.get(resolvedWindowId);
      if (offer && await offerStillValid(offer, groupableTabs, effectiveSettings)) {
        trace.mark('plan_offer_pending');
        return leaveStrip('plan-offer-pending', 'A late grouping for this window is waiting. Apply it from the popup.', { planOffer: true });
      }
      if (offer) await PlanOfferStore.remove(resolvedWindowId);

      // The request for this tab set already missed its click's deadline: it
      // is not sent again, and its answer will only be offered.
      const late = latePlans.get(resolvedWindowId);
      if (late?.key === binding.key) {
        trace.mark('plan_still_pending');
        return leaveStrip('plan-pending', 'The model is still answering for this window. Its grouping will be offered here.', { planPending: true });
      }
      if (late) cancelPlanWork(resolvedWindowId);

      // Upkeep: few new tabs since the last model plan for this engine scope
      // are attached locally, and no request is sent.
      if (storedBase) {
        const memory = await PlanMemory.read({ scope: labelScope });
        const appliedIds = new Set((storedApplied?.groups || []).flatMap(group => group.tabIds || []));
        upkeep = planUpkeep(storedBase, groupableTabs, locked, { fingerprints, memory, appliedIds });
        if (upkeep) {
          finalGroups = upkeep.groups;
          unplacedTabIds = upkeep.unplaced;
          // The tabs this click places: new tabs, and rule or Socials tabs the
          // last applied result did not place. Review Later as stored.
          const lockedNew = locked.flatMap(group => group.tabIds || []).filter(id => !appliedIds.has(id));
          // A new tab the last result already placed is not placed again (the
          // user may have dragged it out); it still counts as new against the base.
          upkeep.newIds = [...new Set([...upkeep.freshIds.filter(id => !appliedIds.has(id)), ...lockedNew])];
          upkeep.reviewIds = new Set((storedApplied?.groups || []).filter(isReviewPlanGroup).flatMap(group => group.tabIds || []));
          resultSource = 'plan-upkeep';
          labelSources = { ...labelSources, tokenAttach: upkeep.attached, review: upkeep.review };
          trace.mark('plan_upkeep', { fresh: upkeep.fresh, attached: upkeep.attached, review: upkeep.review });
          console.log(`[Foldnex] Kept the plan for ${n} tabs; attached ${upkeep.attached} new tabs locally.`);
        }
      }
    }

    let plan = null;
    let localEngine = false;
    if (finalGroups.length === 0) {
      const options = {
        budget,
        trace,
        windowId: resolvedWindowId,
        incognito: isIncognitoWindow,
        provider,
        epoch,
        tableLoad
      };
      const outcome = planEngine
        ? await groupByPlan(groupableTabs, locked, effectiveSettings, { ...options, scope: labelScope, cacheScope, binding, onPlanOffer, onPlanFailed })
        : await groupOffline(groupableTabs, locked, effectiveSettings, options);
      planApplied = Boolean(outcome.planApplied);
      localEngine = Boolean(outcome.localEngine);
      finalGroups = outcome.groups;
      resultSource = outcome.source;
      aiMeta = outcome.meta;
      deadlineHit = outcome.deadlineHit;
      labelSources = outcome.labelSources;
      modelCalls = outcome.modelCalls;
      fallbackCode = outcome.fallbackCode;
      fallbackUsed = outcome.fallbackUsed;
      fallbackReason = outcome.fallbackReason;
      qualityIssues = [...outcome.qualityFlags];
      plan = outcome.plan;
      planReviewOnly = Boolean(outcome.planReviewOnly);
      unplacedTabIds = outcome.unplacedTabIds || [];
      latePlan = outcome.latePlan || null;
      pending.latePlan = latePlan;
      localEmbedding = outcome.localEmbedding || null;
      if (fallbackUsed) console.warn(`[Foldnex] AI provider failed (${fallbackCode}); placed tabs locally.`);
    }

    // C10: exact-cohort renames, then the ceiling as a safety net on every source.
    if (!isIncognitoWindow) {
      const before = finalGroups;
      const renamed = await LearningCache.applyGroupPreferences(before, groupableTabs);
      finalGroups = renamed.map((group, index) => (
        group.name !== before[index]?.name ? { ...group, nameSource: 'user' } : group
      ));
    }
    finalGroups = mergeGroupsByName(finalGroups);
    // A model plan keeps the measured policy: MAX_GROUPS in total is its only
    // cap, so the compactness target does not apply to it or its cached copy.
    const keepsPlan = planEngine && (planApplied || ['exact-cache', 'stored-plan', 'plan-upkeep'].includes(resultSource));
    // The local engine's result keeps its measured policy too (clusters within
    // MAX_GROUPS), as does an offline result served from the exact cache.
    const keepsPolicy = keepsPlan || localEngine || (provider === 'offline' && resultSource === 'exact-cache');
    if (!keepsPolicy) finalGroups = enforceGroupCeiling(finalGroups, { ceiling, protectedNames: lockedNames });

    const quality = assessGroupingQuality(finalGroups, groupableTabs);
    qualityIssues = [...new Set([...qualityIssues, ...quality.issues])];
    qualityCodes = quality.codes;
    planForStore = {
      K: keepsPolicy ? MAX_GROUPS : ceiling,
      signature: plan?.signature || planSignature(finalGroups),
      groups: finalGroups,
      // Only an applied model plan, or its upkeep, may be reused for its
      // unchanged window. Upkeep keeps counting against the last model plan.
      applied: keepsPlan && binding ? {
        tabSet: binding.signature,
        scope: binding.scope,
        locked: binding.locked,
        groups: finalGroups
      } : null,
      // The last model plan for this engine scope survives a failed, late or
      // review-only click; a click on another scope or engine ends it.
      base: binding && planEngine && (planApplied || resultSource === 'exact-cache')
        ? { scope: binding.scope, ...planBase(finalGroups, fingerprints, locked) }
        : storedBase
    };

    // C12 (part): the exact cache holds only final results.
    // A plan engine caches only an applied plan, never its local stand-in.
    const cacheable = resultSource !== 'exact-cache'
      && (!planEngine || planApplied)
      && !fallbackUsed
      && !fallbackCode
      && !deadlineHit;
    if (!isIncognitoWindow && cacheable) {
      exactCacheToWrite = exactCacheContext || await ExactResultCache.makeContext(groupableTabs, cacheScope);
    }
  }

  trace.mark('groups_ready', { groups: finalGroups.length, source: resultSource });

  let groupsCreatedCount = 0;
  try {
    // Upkeep works on the strip as it is unless the strip has no group at all.
    const onStrip = upkeep ? await placeUpkeepOnStrip(finalGroups, upkeep.newIds, resolvedWindowId, {
      reviewIds: upkeep.reviewIds,
      collapse: Boolean(effectiveSettings.collapseGroupsOnCreation)
    }) : null;
    if (onStrip) {
      groupsCreatedCount = onStrip.created;
      finalGroups = onStrip.groups;
      unplacedTabIds = [...new Set([...unplacedTabIds, ...onStrip.unplaced])];
      upkeep = { ...upkeep, attached: onStrip.attached, review: onStrip.review };
      labelSources = { ...labelSources, tokenAttach: onStrip.attached, review: onStrip.review };
      if (planForStore) {
        planForStore.groups = finalGroups;
        planForStore.signature = planSignature(finalGroups);
        if (planForStore.applied) planForStore.applied.groups = finalGroups;
      }
    } else {
      groupsCreatedCount = await applyGroupsToWindow(finalGroups, resolvedWindowId, {
        incognito: isIncognitoWindow,
        collapse: Boolean(effectiveSettings.collapseGroupsOnCreation)
      });
    }
    // Tabs reported as ungrouped (no free slot) leave any group they were in;
    // upkeep never takes a tab out of a group.
    if (unplacedTabIds.length > 0 && !upkeep) await ungroupTabs(unplacedTabIds, resolvedWindowId);
    // A late plan's offer is checked against the membership the local result left.
    if (latePlan) {
      const placed = await chrome.tabs.query({ windowId: resolvedWindowId });
      latePlan.setBaseline(readMembership(getGroupableTabs(placed.filter(tab => !tab.incognito))));
    }
  } finally {
    latePlan?.setBaseline(null);
  }
  trace.mark('groups_applied', { created: groupsCreatedCount });

  // C12: persist after the strip is regrouped.
  if (!isIncognitoWindow && groupingStrategy === 'task') {
    if (planForStore) await WindowPlanStore.put(resolvedWindowId, planForStore, { epoch });
    if (exactCacheToWrite) await ExactResultCache.put(exactCacheToWrite, finalGroups, { epoch });
    if (planApplied) {
      // This window took a plan: an offer or request from an earlier late click is stale.
      cancelPlanWork(resolvedWindowId);
      await PlanOfferStore.remove(resolvedWindowId);
    }
  }

  const nameSources = countNameSources(finalGroups);

  // Record privacy-safe diagnostics. Raw titles, URLs, prompts, and provider
  // response bodies are intentionally excluded.
  if (!isIncognitoWindow) {
    const now = Date.now();
    const usage = aiMeta?.usage || {};
    const reportedReasoningTokens = Number.isFinite(usage.reasoningTokens) ? usage.reasoningTokens : null;
    const modelWork = Object.values(modelCalls).some(count => count > 0);
    // A plan request reports the effort it sent, which ignores the saved one.
    const recordedReasoningEffort = !usesCloudEngine(effectiveSettings) || !modelWork ? null
      : planEngine ? aiMeta?.reasoningEffort ?? planEffort
        : aiMeta?.reasoningEffort || effectiveReasoningEffort;
    await recordRun({
      timestamp: now,
      groupsCreated: groupsCreatedCount,
      tabsGrouped: n,
      duplicateTabsClosed,
      strategy: groupingStrategy,
      provider,
      providerMode: usesCloudEngine(effectiveSettings) ? 'cloud' : 'local',
      model: groupingStrategy === 'task' ? aiMeta?.model || requestedModel : null,
      reasoningEffort: recordedReasoningEffort,
      source: resultSource,
      promptVersion: PROMPT_VERSION,
      promptTokens: Number(usage.promptTokens || 0),
      completionTokens: Number(usage.completionTokens || 0),
      cachedTokens: Number(usage.cachedTokens || 0),
      cacheWriteTokens: Number(usage.cacheWriteTokens || 0),
      reasoningTokens: reportedReasoningTokens,
      latencyMs: Math.round(performance.now() - runStartedAt),
      providerLatencyMs: Number(aiMeta?.latencyMs || 0),
      qualityFlags: qualityIssues,
      fallbackCode,
      fallbackDetail: fallbackReason,
      groupCeiling: ceiling,
      labelSources,
      modelCalls,
      nameSources,
      deadlineHit,
      budgetMs,
      groups: finalGroups.map(group => ({ name: group.name, size: group.tabIds?.length || 0 }))
    });
  }

  return {
    success: true,
    fallbackUsed,
    fallbackReason,
    fallbackCode,
    message: groupingStrategy === 'site'
      ? `Organized ${n} tabs into ${groupsCreatedCount} groups by site category.`
      : planReviewOnly
        ? `Organized ${n} tabs into ${groupsCreatedCount} groups locally; the model put every tab in Review Later.`
      : upkeep
        ? `Kept the model's groups for ${n} tabs${upkeep.attached > 0 ? ` and added ${upkeep.attached} new ${upkeep.attached === 1 ? 'tab' : 'tabs'} to existing groups` : ''}; no request sent.`
      : fallbackUsed && fallbackCode === 'permission'
        ? `Organized ${n} tabs into ${groupsCreatedCount} groups locally; nothing was sent because access to ${PROVIDER_CATALOG[provider]?.name || 'the engine'} is not allowed. Allow it in Settings.`
      : fallbackUsed
        ? `Organized ${n} tabs into ${groupsCreatedCount} groups using Offline Smart Mode (AI unavailable/blocked).`
        : `Successfully organized ${n} tabs into ${groupsCreatedCount} groups!`,
    groupsCreated: groupsCreatedCount,
    totalTabs: n,
    duplicateTabsClosed,
    strategy: groupingStrategy,
    provider,
    source: resultSource,
    model: groupingStrategy === 'task' ? aiMeta?.model || requestedModel : null,
    reasoningEffort: resultSource === 'cloud-plan' ? aiMeta?.reasoningEffort ?? planEffort : null,
    reasoningTokens: Number.isFinite(aiMeta?.usage?.reasoningTokens) ? aiMeta.usage.reasoningTokens : null,
    qualityFlags: qualityIssues,
    qualityCodes,
    groups: finalGroups,
    groupCeiling: ceiling,
    nameSources,
    deadlineHit,
    planPending: resultSource === 'plan-pending',
    planReviewOnly,
    unplacedTabIds,
    unplacedTabs: unplacedTabIds.length,
    planEngine,
    localEmbedding,
    upkeepAttached: upkeep ? upkeep.attached : 0,
    upkeepReview: upkeep ? upkeep.review : 0,
    windowId: resolvedWindowId,
    incognito: isIncognitoWindow
  };
}

/**
 * Apply groups to a window's tab strip in strip order, each with a valid,
 * non-repeating colour. Tabs closed or pinned meanwhile are skipped; a group
 * that fails is retried with its surviving tabs. Returns the groups created.
 */
async function applyGroupsToWindow(finalGroups, windowId, options = {}) {
  return (await placeGroups(finalGroups, windowId, options)).created;
}

/**
 * applyGroupsToWindow's work, reporting {created, failed}: a group counts as
 * failed when Chrome refused it and its retry. `liveTabs` is a snapshot the
 * caller has just verified; otherwise the window is read here.
 */
async function placeGroups(finalGroups, windowId, { incognito = false, collapse = false, liveTabs = null } = {}) {
  // Tab strip ordering & anti-thrashing
  // Re-verify current live tabs to prevent "No tab with id" errors during async gap
  const currentLiveTabs = liveTabs || await chrome.tabs.query({ windowId: windowId });
  const liveTabMap = new Map(currentLiveTabs.filter(t => !t.pinned).map(t => [t.id, t]));
  const tabIndexMap = new Map(currentLiveTabs.map(t => [t.id, t.index]));

  // Sort tabIds within each group to preserve natural left-to-right order
  for (const grp of finalGroups) {
    grp.tabIds.sort((a, b) => (tabIndexMap.get(a) ?? 0) - (tabIndexMap.get(b) ?? 0));
  }

  // Sort groups by their leftmost tab index so groups form sequentially from left to right
  finalGroups.sort((g1, g2) => {
    const minA = g1.tabIds.length > 0 ? Math.min(...g1.tabIds.map(id => tabIndexMap.get(id) ?? Infinity)) : Infinity;
    const minB = g2.tabIds.length > 0 ? Math.min(...g2.tabIds.map(id => tabIndexMap.get(id) ?? Infinity)) : Infinity;
    return minA - minB;
  });

  // Step 4: Apply groups to Chrome Tab Strip
  let groupsCreatedCount = 0;
  let groupsFailed = 0;
  let lastAssignedColor = null;

  for (let i = 0; i < finalGroups.length; i++) {
    const grp = finalGroups[i];
    if (!grp.tabIds || grp.tabIds.length === 0) continue;

    // Filter tabIds to only those that currently exist and are unpinned
    const validTabIds = grp.tabIds.filter(id => liveTabMap.has(id));
    if (validTabIds.length === 0) continue;

    // Color fallback: ensure valid Chrome color and prevent adjacent duplicate colors
    let assignedColor = grp.color;
    if (!assignedColor || !CHROME_GROUP_COLORS.includes(assignedColor)) {
      assignedColor = CHROME_GROUP_COLORS[i % CHROME_GROUP_COLORS.length];
    }
    if (i > 0 && assignedColor === lastAssignedColor) {
      const nextColorIdx = (CHROME_GROUP_COLORS.indexOf(assignedColor) + 1) % CHROME_GROUP_COLORS.length;
      assignedColor = CHROME_GROUP_COLORS[nextColorIdx];
    }
    lastAssignedColor = assignedColor;

    try {
      const groupId = await chrome.tabs.group({
        tabIds: validTabIds,
        createProperties: { windowId: windowId }
      });

      // Register in shared session state before the title event reaches the
      // background worker's rename listener.
      await markProgrammaticGroupUpdate(groupId, grp.name, { incognito: incognito });

      await chrome.tabGroups.update(groupId, {
        title: grp.name,
        color: assignedColor,
        collapsed: collapse
      });

      groupsCreatedCount++;
    } catch (err) {
      // Group names stay out of logs: they can reveal browsing context.
      console.warn('[Foldnex] Retrying a group after a tab state change:', err?.message);
      try {
        const survivingIds = [];
        for (const id of validTabIds) {
          try {
            const t = await chrome.tabs.get(id);
            if (t && t.windowId === windowId && !t.pinned) survivingIds.push(id);
          } catch { /* Tab was closed */ }
        }
        if (survivingIds.length > 0) {
          const groupId = await chrome.tabs.group({
            tabIds: survivingIds,
            createProperties: { windowId: windowId }
          });
          await markProgrammaticGroupUpdate(groupId, grp.name, { incognito: incognito });
          await chrome.tabGroups.update(groupId, {
            title: grp.name,
            color: assignedColor,
            collapsed: collapse
          });
          groupsCreatedCount++;
        } else {
          groupsFailed++;
        }
      } catch (retryErr) {
        groupsFailed++;
        console.error('[Foldnex] A group could not be placed:', retryErr?.message);
      }
    }
  }

  return { created: groupsCreatedCount, failed: groupsFailed };
}

/** Remove these tabs from any group they are in, where they are still in the window. */
async function ungroupTabs(tabIds, windowId) {
  const ids = new Set(tabIds);
  const tabs = await chrome.tabs.query({ windowId });
  const grouped = tabs
    .filter(tab => ids.has(tab.id) && Number.isInteger(tab.groupId) && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
    .map(tab => tab.id);
  if (grouped.length === 0) return;
  try {
    await chrome.tabs.ungroup(grouped);
  } catch (err) {
    console.warn('[Foldnex] Could not ungroup the unplaced tabs:', err);
  }
}

/**
 * Ungroup all tabs in the window with resilient atomic fallback
 */
export async function ungroupAllTabs(windowId) {
  try {
    let targetWindowId = windowId;
    if (!targetWindowId) {
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      targetWindowId = activeTab?.windowId;
    }

    const queryParams = targetWindowId ? { windowId: targetWindowId } : { currentWindow: true };
    const tabs = await chrome.tabs.query(queryParams);
    // Ungroup ends the window's late plan: no request is sent after it, one in
    // flight offers nothing, and a waiting offer goes. Private windows have none.
    const ungroupedWindowId = targetWindowId ?? tabs[0]?.windowId;
    if (Number.isInteger(ungroupedWindowId) && !tabs.some(tab => tab.incognito)) {
      cancelPlanWork(ungroupedWindowId);
      await PlanOfferStore.remove(ungroupedWindowId);
    }
    const groupedTabIds = tabs
      .filter(t => Number.isInteger(t.groupId) && t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
      .map(t => t.id);

    if (groupedTabIds.length === 0) {
      return { ungroupedCount: 0 };
    }

    // Try batch ungrouping first
    try {
      await chrome.tabs.ungroup(groupedTabIds);
      return { ungroupedCount: groupedTabIds.length };
    } catch (batchErr) {
      console.warn('[Foldnex] Batch ungroup failed. Retrying per-tab:', batchErr);
      let successCount = 0;
      for (const tabId of groupedTabIds) {
        try {
          await chrome.tabs.ungroup(tabId);
          successCount++;
        } catch {
          // Tab may have closed
        }
      }
      return { ungroupedCount: successCount };
    }
  } catch (err) {
    console.error('[Foldnex] Critical error in ungroupAllTabs:', err);
    throw err;
  }
}
