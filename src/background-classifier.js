/**
 * Foldnex - Background classifier
 * Labels tabs as they finish loading and keeps each window's plan and names
 * current, so a later cleanup only applies cached labels and names. On-device
 * engines (Nano, Ollama on a loopback address) run silently once the user
 * turned on background preparation or auto-grouping. Cloud engines run here
 * only when the user turned on auto-grouping, only for tabs opened or
 * navigated to a new page since then, and never consolidate.
 */

import {
  CLOUD_BATCH_SIZE,
  consolidateWithCloud,
  groupCeiling,
  isLoopbackUrl,
  labelTabsWithAI,
  nameGroupsWithNano,
  NANO_BACKGROUND_BATCH,
  PROVIDER_CATALOG,
  providerSettingKey,
  updateNanoPerf
} from './ai-engine.js';
import { hashToken, PlanMemory, TabLabelCache, WindowPlanStore } from './cache-engine.js';
import { createTrace, noopTrace } from './debug-trace.js';
import { markProgrammaticGroupUpdate } from './group-state.js';
import {
  acceptEnginesFor,
  applyFolders,
  applyModelNames,
  buildLockedGroups,
  consolidationLimit,
  getGroupableTabs,
  getRunScope,
  hasFolders,
  loadGroupingSettings,
  namingNeed
} from './grouper.js';
import {
  buildLocalContext,
  ensureUniqueNames,
  inferLocalLabel,
  labelPriority,
  planGroups,
  REVIEW_GROUP_NAME,
  transferNames
} from './planner.js';

export const FLUSH_DELAY_MS = 1500;
// A tab that keeps changing cannot hold the queue back longer than this.
export const FLUSH_MAX_WAIT_MS = 5000;
export const PLAN_REFRESH_DELAY_MS = 4000;
export const PLAN_REFRESH_MAX_POSTPONE_MS = 15000;
export const NAMING_RATE_LIMIT_MS = 30000;
export const TITLE_RELABEL_INTERVAL_MS = 10 * 60 * 1000;
// Title changes this soon after a navigation belong to the page load.
export const NAVIGATION_SETTLE_MS = 10000;
export const RETRY_DELAYS_MS = Object.freeze([5000, 30000, 120000]);
export const NEW_TABS_KEY = 'foldnex_new_tabs_v1';
const NO_GROUP = -1;
const REASON_RANK = Object.freeze({ title: 0, other: 1, load: 2, cleanup: 3 });

// Last background naming attempt per window: {at, signature}. In memory
// only; a service-worker restart simply allows one more attempt.
const namingAttempts = new Map();

export { isLoopbackUrl };

/** Engines whose tab data stays on this device: Nano, and Ollama on a loopback address. */
export function isOnDeviceEngine(settings = {}) {
  const provider = settings?.provider || 'gemini_nano';
  if (provider === 'gemini_nano') return true;
  if (provider !== 'ollama') return false;
  return isLoopbackUrl(settings[providerSettingKey('ollama', 'baseUrl')] || PROVIDER_CATALOG.ollama.baseUrl);
}

/** The consent gates: By task, a model engine, and cloud only with Auto-group. */
function backgroundAllowed(settings) {
  const { provider, groupingStrategy } = getRunScope(settings);
  if (groupingStrategy !== 'task' || provider === 'offline') return false;
  return isOnDeviceEngine(settings) || Boolean(settings.autoGroupNewTabs);
}

/**
 * Background work is opt-in: background preparation (backgroundPrep), or
 * Auto-group, which needs labels. For a cloud engine only Auto-group counts,
 * through the consent gates.
 */
function backgroundPrepared(settings) {
  return settings.backgroundPrep === true || Boolean(settings.autoGroupNewTabs);
}

/**
 * What the background may do under the saved settings: `allowed` at all
 * (the consent gates plus the opt-in, which the queue and the service worker
 * apply), `onDevice` (any tab may be labelled) or cloud (only new pages), and
 * whether Auto-group is on.
 */
export async function loadBackgroundScope(settings = null) {
  const resolved = settings || await loadGroupingSettings();
  return {
    allowed: backgroundAllowed(resolved) && backgroundPrepared(resolved),
    // Without the opt-in, an on-device engine still finishes the tabs a
    // cleanup the user just ran placed by address, then stops.
    cleanupFollowUp: backgroundAllowed(resolved) && isOnDeviceEngine(resolved),
    onDevice: isOnDeviceEngine(resolved),
    autoGroup: Boolean(resolved.autoGroupNewTabs)
  };
}

/** Address identity for "a new page": the URL without its fragment, hashed. */
export function pageKey(url) {
  return hashToken(String(url || '').replace(/#.*$/, ''));
}

async function liveTabs(tabIds) {
  const tabs = await Promise.all(tabIds.map(id => chrome.tabs.get(id).catch(() => null)));
  // Discarded and not-yet-loaded tabs keep their title; a loading tab is
  // queued again when it completes.
  return getGroupableTabs(tabs.filter(tab => tab && !tab.incognito && tab.title && tab.status !== 'loading'));
}

/** Cached labels for a pool, plus local inference for the rest. */
async function resolvePoolLabels(pool, provider) {
  const lookup = await TabLabelCache.lookup(pool, { acceptEngines: acceptEnginesFor(provider) });
  const labelsById = new Map();
  for (const [id, entry] of lookup.labels) labelsById.set(id, { c: entry.c, src: 'cache' });
  const ctx = buildLocalContext(pool, labelsById);
  for (const tab of lookup.missing) {
    const inferred = inferLocalLabel(tab, ctx);
    if (inferred) labelsById.set(tab.id, inferred);
  }
  return { lookup, labelsById };
}

/**
 * B3: label tabs with the selected engine, one batch at a time, and store
 * each batch as soon as it lands. Locked tabs (rules, Socials) are never
 * labelled. Which tabs may be sent is the queue's decision.
 * @returns {Promise<{windowIds: number[], storedWindowIds: number[], labelledIds: number[], unlabelledIds: number[], aborted: boolean, error: Error|null}>}
 *   `windowIds` holds every live tab's window, `storedWindowIds` only the
 *   windows that got a new label, and `unlabelledIds` the tabs sent to the
 *   engine that came back without one.
 */
export async function classifyTabs(tabIds, signal = null) {
  const empty = { windowIds: [], storedWindowIds: [], labelledIds: [], unlabelledIds: [], aborted: false, error: null };
  const settings = await loadGroupingSettings();
  if (!backgroundAllowed(settings)) return empty;
  const { provider } = getRunScope(settings);

  const tabs = await liveTabs(tabIds);
  if (tabs.length === 0) return empty;
  const windowIds = [...new Set(tabs.map(tab => tab.windowId))];

  const { pool } = await buildLockedGroups(tabs, { incognito: false });
  if (pool.length === 0) return { ...empty, windowIds };

  const trace = createTrace({ kind: 'background', tabsInWindow: tabs.length });
  const lookup = await TabLabelCache.lookup(pool, { acceptEngines: acceptEnginesFor(provider) });
  trace.mark('bg_start', { tabs: pool.length, pending: lookup.missing.length, provider });
  if (lookup.missing.length === 0) return { ...empty, windowIds };

  // A prioritised window's tabs arrive first; within a window the tabs the
  // planner can place least well are labelled first.
  const cached = new Map([...lookup.labels].map(([id, entry]) => [id, { c: entry.c, src: 'cache' }]));
  const ctx = buildLocalContext(pool, cached);
  const windowRank = new Map(windowIds.map((id, index) => [id, index]));
  const ordered = lookup.missing
    .map((tab, position) => ({ tab, position, rank: windowRank.get(tab.windowId), priority: labelPriority(tab, ctx) }))
    .sort((a, b) => a.rank - b.rank || a.priority - b.priority || a.position - b.position)
    .map(entry => entry.tab);

  const windowOf = new Map(tabs.map(tab => [tab.id, tab.windowId]));
  const stored = new Set();
  let result;
  try {
    result = await labelTabsWithAI(ordered, settings, {
      signal,
      trace,
      batchSize: provider === 'gemini_nano' ? NANO_BACKGROUND_BATCH : CLOUD_BATCH_SIZE,
      // Background batches never burst: rate limits and local servers see one at a time.
      sequential: true,
      onBatch: async (labels, info) => {
        await TabLabelCache.store(labels, lookup.fingerprintById, provider);
        for (const id of labels.keys()) stored.add(id);
        if (provider === 'gemini_nano' && info.count > 0) await updateNanoPerf({ count: info.count, elapsedMs: info.ms });
        trace.mark('bg_stored', { labels: labels.size });
      }
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    result = {
      error,
      aborted: false,
      unlabelledIds: Array.isArray(error?.unlabelledIds) ? error.unlabelledIds : ordered.map(tab => tab.id)
    };
  }
  if (result.error) console.warn('[Foldnex] Background labelling stopped early:', result.error?.message);

  const labelledIds = [...stored];
  const unlabelledIds = result.aborted
    ? []
    : (Array.isArray(result.unlabelledIds) ? result.unlabelledIds : ordered.map(tab => tab.id))
      .filter(id => !stored.has(id));
  return {
    windowIds,
    storedWindowIds: [...new Set(labelledIds.map(id => windowOf.get(id)))],
    labelledIds,
    unlabelledIds,
    aborted: Boolean(result.aborted),
    error: result.error || null
  };
}

/**
 * B5: recompute a window's plan from cached labels and local inference, carry
 * remembered names over and, for on-device engines only, ask for names when
 * the plan changed and memory names fewer than half of its groups (at most
 * once per window every NAMING_RATE_LIMIT_MS). Cloud engines keep
 * deterministic names here: no extra paid call. Writes WindowPlanStore and
 * PlanMemory.
 * @returns {Promise<{K: number, signature: string, groups: object[]}|null>}
 */
export async function refreshWindowPlan(windowId, settings, signal = null, { trace = noopTrace } = {}) {
  const windowTabs = getGroupableTabs(await chrome.tabs.query({ windowId }));
  // Incognito windows are never planned, named or stored.
  if (windowTabs.length < 2 || windowTabs.some(tab => tab.incognito)) return null;
  const { provider } = getRunScope(settings);

  const { locked, pool } = await buildLockedGroups(windowTabs, { incognito: false });
  const { lookup, labelsById } = await resolvePoolLabels(pool, provider);
  const memory = await PlanMemory.read();
  signal?.throwIfAborted();

  const plan = planGroups(pool, labelsById, { locked, advice: memory.advice.cloud });
  const tabsById = new Map(windowTabs.map(tab => [tab.id, tab]));
  const fingerprintById = lookup.fingerprintById;
  let groups = transferNames(plan.groups, memory, { tabsById, tokensById: plan.tokensById, fingerprintById });
  groups = ensureUniqueNames(groups, locked, { tabsById });

  const need = namingNeed(groups);
  const previous = namingAttempts.get(windowId);
  const localNamer = isOnDeviceEngine(settings);
  const due = !previous || (previous.signature !== plan.signature && Date.now() - previous.at >= NAMING_RATE_LIMIT_MS);
  if (localNamer && need.needed && due) {
    namingAttempts.set(windowId, { at: Date.now(), signature: plan.signature });
    try {
      if (provider === 'gemini_nano') {
        const raw = await nameGroupsWithNano(need.toName, tabsById, { signal, trace });
        const records = applyModelNames(need.toName, raw, groups, { tabsById, tokensById: plan.tokensById });
        if (records.length > 0) await PlanMemory.putNames(records);
      } else {
        // Ollama on this device, so its consolidation may run here.
        const k = consolidationLimit(plan, groups);
        const result = await consolidateWithCloud(plan.candidates, k, settings, { signal, trace, tabsById });
        if (hasFolders(result)) {
          const applied = applyFolders(groups, plan, result.folders, k, { tabsById, memory, fingerprintById });
          groups = applied.groups;
          if (applied.records.length > 0) await PlanMemory.putNames(applied.records);
          await PlanMemory.putAdvice(applied.advice);
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        // A cleanup took the model; let the next refresh try again.
        if (previous) namingAttempts.set(windowId, previous);
        else namingAttempts.delete(windowId);
        throw error;
      }
      console.warn('[Foldnex] Background naming failed:', error?.message);
    }
  }

  signal?.throwIfAborted();
  const record = { K: plan.K, signature: plan.signature, groups };
  await WindowPlanStore.put(windowId, record);
  trace.mark('bg_plan_refreshed', { windowId, groups: groups.length });
  return record;
}

function isReviewTitle(title) {
  return String(title || '').toLowerCase() === REVIEW_GROUP_NAME.toLowerCase();
}

/**
 * The Chrome group a plan group lives in: the one holding most of its
 * already-grouped members (Review Later aside). Only when no member is
 * grouped does a Chrome group with the same title count.
 */
function resolveChromeGroup(group, groupIdOf, titleOf, byTitle) {
  const votes = new Map();
  for (const id of group.tabIds || []) {
    const groupId = groupIdOf.get(id);
    if (groupId === undefined || groupId === NO_GROUP || isReviewTitle(titleOf.get(groupId))) continue;
    votes.set(groupId, (votes.get(groupId) || 0) + 1);
  }
  let best;
  for (const [groupId, count] of votes) {
    if (best === undefined || count > votes.get(best)) best = groupId;
  }
  return best !== undefined ? best : byTitle.get(group.name.toLowerCase());
}

/** The tabs that are still ungrouped, open and in this window right now. */
async function stillUngrouped(tabIds, windowId) {
  const tabs = await Promise.all(tabIds.map(id => chrome.tabs.get(id).catch(() => null)));
  return tabs
    .filter(tab => tab && tab.windowId === windowId && !tab.pinned && (tab.groupId ?? NO_GROUP) === NO_GROUP)
    .map(tab => tab.id);
}

/**
 * B6: file ungrouped candidate tabs into the Chrome group their plan group
 * already occupies, or create that group once two of them share it, no
 * member is grouped yet, and the window still has fewer titled groups than
 * its ceiling. Grouped tabs are never moved and Review Later is never
 * auto-created. `candidateIds` limits which ungrouped tabs may move (null:
 * every ungrouped tab). An abort stops before the next Chrome change; a
 * group already created still gets its title.
 * @returns {Promise<number>} tabs moved
 */
export async function autoGroupWindow(windowId, plan, {
  trace = noopTrace,
  signal = null,
  candidateIds = null,
  onGrouped = null
} = {}) {
  const windowTabs = getGroupableTabs(await chrome.tabs.query({ windowId }));
  if (windowTabs.length === 0 || windowTabs.some(tab => tab.incognito)) return 0;
  const allowed = candidateIds === null || candidateIds === undefined ? null : new Set(candidateIds);
  const movable = new Set(windowTabs
    .filter(tab => (tab.groupId ?? NO_GROUP) === NO_GROUP && (!allowed || allowed.has(tab.id)))
    .map(tab => tab.id));
  if (movable.size === 0 || !Array.isArray(plan?.groups)) return 0;

  const chromeGroups = await chrome.tabGroups.query({ windowId });
  const titleOf = new Map(chromeGroups.map(group => [group.id, group.title || '']));
  const byTitle = new Map(chromeGroups.filter(group => group.title).map(group => [group.title.toLowerCase(), group.id]));
  const groupIdOf = new Map(windowTabs.map(tab => [tab.id, tab.groupId ?? NO_GROUP]));
  const ceiling = groupCeiling(windowTabs.length);

  const targets = [];
  for (const group of plan.groups) {
    if (!group?.name || group.kind === 'review' || isReviewTitle(group.name)) continue;
    const members = new Set(group.tabIds || []);
    const tabIds = windowTabs.filter(tab => movable.has(tab.id) && members.has(tab.id)).map(tab => tab.id);
    if (tabIds.length === 0) continue;
    targets.push({ name: group.name, color: group.color, groupId: resolveChromeGroup(group, groupIdOf, titleOf, byTitle), tabIds });
  }

  let moved = 0;
  for (const target of targets) {
    signal?.throwIfAborted();
    // Re-read: a cleanup or the user may have grouped these tabs meanwhile.
    const tabIds = await stillUngrouped(target.tabIds, windowId);
    if (tabIds.length === 0) continue;
    try {
      if (target.groupId !== undefined) {
        signal?.throwIfAborted();
        await chrome.tabs.group({ groupId: target.groupId, tabIds });
      } else {
        if (tabIds.length < 2) continue;
        const titled = (await chrome.tabGroups.query({ windowId })).filter(group => group.title).length;
        if (titled >= ceiling) continue;
        signal?.throwIfAborted();
        const newGroupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
        // Title it even if paused meanwhile, so no unnamed group is left behind.
        await markProgrammaticGroupUpdate(newGroupId, target.name);
        await chrome.tabGroups.update(newGroupId, { title: target.name, color: target.color || 'grey' });
      }
      moved += tabIds.length;
      await onGrouped?.(tabIds);
    } catch (error) {
      if (signal?.aborted) throw error;
      // Tabs may close or move while the classifier runs.
    }
  }
  trace.mark('bg_auto_grouped', { windowId, moved });
  return moved;
}

/**
 * B5 then B6 for one window, under the consent gates. Auto-grouping runs only
 * when `autoGroup` is set and the setting is on; `candidateIds` and
 * `onGrouped` pass through to autoGroupWindow.
 */
export async function refreshAndAutoGroup(windowId, signal = null, {
  autoGroup = true,
  candidateIds = null,
  onGrouped = null
} = {}) {
  const settings = await loadGroupingSettings();
  if (!backgroundAllowed(settings)) return null;
  const trace = createTrace({ kind: 'background' });
  const plan = await refreshWindowPlan(windowId, settings, signal, { trace });
  if (plan && autoGroup && settings.autoGroupNewTabs) {
    signal?.throwIfAborted();
    await autoGroupWindow(windowId, plan, { trace, signal, candidateIds, onGrouped });
  }
  return plan;
}

/**
 * Development aid: each tab's label and where it came from, computed on
 * demand and never stored. Rows hold the host only, never titles or paths.
 */
export async function dumpWindowLabels(windowId) {
  const settings = await loadGroupingSettings();
  const { provider } = getRunScope(settings);
  const tabs = getGroupableTabs(await chrome.tabs.query({ windowId })).filter(tab => !tab.incognito);
  const { labelsById } = await resolvePoolLabels(tabs, provider);
  return tabs.map(tab => {
    let host = '';
    try {
      host = new URL(tab.url).hostname;
    } catch {
      // Not a web page.
    }
    const label = labelsById.get(tab.id);
    return { index: tab.index, host, c: label?.c ?? null, src: label?.src ?? null };
  });
}

/**
 * Tabs opened or navigated to a new page while Auto-group was on ("fresh"),
 * the subset still waiting to be auto-grouped ("candidates"), and the page
 * key of each tab taken out of a group. Session storage keeps them across
 * service-worker restarts and drops them with the browser session.
 */
export function createNewTabTracker({ area = () => globalThis.chrome?.storage?.session } = {}) {
  let state = null;
  let loading = null;
  let saving = Promise.resolve();

  function ready() {
    if (state) return Promise.resolve(state);
    loading ??= Promise.resolve()
      .then(() => area()?.get(NEW_TABS_KEY))
      .catch(() => null)
      .then(stored => {
        const record = stored?.[NEW_TABS_KEY] || {};
        state = {
          fresh: new Set(Array.isArray(record.fresh) ? record.fresh : []),
          candidates: new Set(Array.isArray(record.candidates) ? record.candidates : []),
          outKeys: new Map(Object.entries(record.out || {}).map(([id, key]) => [Number(id), key]))
        };
        return state;
      });
    return loading;
  }

  function save() {
    const record = {
      fresh: [...state.fresh],
      candidates: [...state.candidates],
      out: Object.fromEntries(state.outKeys)
    };
    saving = saving.then(() => area()?.set({ [NEW_TABS_KEY]: record })).catch(() => {});
    return saving;
  }

  return {
    ready,
    async markNew(tabId, { grouped = false } = {}) {
      const s = await ready();
      s.fresh.add(tabId);
      s.outKeys.delete(tabId);
      if (!grouped) s.candidates.add(tabId);
      else s.candidates.delete(tabId);
      await save();
    },
    async markGrouped(tabIds) {
      const s = await ready();
      let changed = false;
      for (const id of tabIds || []) changed = s.candidates.delete(id) || changed;
      if (changed) await save();
    },
    /** Taken out of a group, or ungrouped by Ungroup all: stays out until a new page. */
    async markTakenOut(entries) {
      const s = await ready();
      for (const [tabId, key] of entries || []) {
        s.candidates.delete(tabId);
        s.outKeys.set(tabId, key);
      }
      await save();
    },
    async forget(tabId) {
      const s = await ready();
      const changed = [s.fresh.delete(tabId), s.candidates.delete(tabId), s.outKeys.delete(tabId)].some(Boolean);
      if (changed) await save();
    },
    async clear() {
      const s = await ready();
      s.fresh.clear();
      s.candidates.clear();
      s.outKeys.clear();
      await save();
    },
    async outKey(tabId) {
      return (await ready()).outKeys.get(tabId);
    },
    async freshIds() {
      return [...(await ready()).fresh];
    },
    async candidateIds() {
      return [...(await ready()).candidates];
    },
    flushed() {
      return saving;
    }
  };
}

/**
 * Debounced queue around classifyTabs and the per-window plan refreshes. Both
 * run inside flush() under one AbortController, so pause() cancels either and
 * a cleanup gets the model at once; cancelled work returns to the queue and
 * resume() continues after the cleanup.
 *
 * Queue reasons: 'load' (a page finished loading or navigated), 'title' (a
 * title-only change, or an address change within the same document) and
 * 'other' (popup open, startup, a cleanup's
 * provisional tabs). Only 'load' of an auto-group candidate lets a plan
 * refresh auto-group. With a cloud engine only fresh tabs, never for a
 * title-only change, are sent.
 */
export function createBackgroundClassifier({
  classify = classifyTabs,
  refresh = refreshAndAutoGroup,
  scope = loadBackgroundScope,
  tracker = createNewTabTracker(),
  flushDelayMs = FLUSH_DELAY_MS,
  flushMaxWaitMs = FLUSH_MAX_WAIT_MS,
  refreshDelayMs = PLAN_REFRESH_DELAY_MS,
  refreshMaxPostponeMs = PLAN_REFRESH_MAX_POSTPONE_MS,
  retryDelaysMs = RETRY_DELAYS_MS,
  titleRelabelMs = TITLE_RELABEL_INTERVAL_MS,
  navigationSettleMs = NAVIGATION_SETTLE_MS
} = {}) {
  const pending = new Map();
  const refreshDue = new Map();
  const retries = new Map();
  const failures = new Map();
  const gaveUp = new Set();
  const labelledAt = new Map();
  const navigatedAt = new Map();
  const lastPageKey = new Map();
  let pendingSince = null;
  let flushTimer = null;
  let refreshTimer = null;
  let retryTimer = null;
  let running = null;
  let idle = Promise.resolve();
  let holds = 0;

  const paused = () => holds > 0;

  function addPending(id, reason) {
    const current = pending.get(id);
    if (current === undefined || REASON_RANK[reason] > REASON_RANK[current]) pending.set(id, reason);
    if (pendingSince === null) pendingSince = Date.now();
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (paused() || pending.size === 0) return;
    if (pendingSince === null) pendingSince = Date.now();
    const wait = Math.max(0, Math.min(flushDelayMs, pendingSince + flushMaxWaitMs - Date.now()));
    flushTimer = setTimeout(flush, wait);
  }

  function armRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = null;
    if (paused() || running || refreshDue.size === 0) return;
    const next = Math.min(...[...refreshDue.values()].map(entry => entry.at));
    refreshTimer = setTimeout(flush, Math.max(0, next - Date.now()));
  }

  function pushRefresh(windowId, autoGroup) {
    if (!Number.isInteger(windowId) || windowId < 0) return;
    const now = Date.now();
    const entry = refreshDue.get(windowId);
    const firstAt = entry?.firstAt ?? now;
    // Counted from the last label store, so a busy window refreshes once,
    // but never postponed past the cap.
    refreshDue.set(windowId, {
      at: Math.min(now + refreshDelayMs, firstAt + refreshMaxPostponeMs),
      firstAt,
      autoGroup: Boolean(entry?.autoGroup || autoGroup)
    });
    armRefresh();
  }

  function armRetry() {
    clearTimeout(retryTimer);
    retryTimer = null;
    if (retries.size === 0) return;
    const next = Math.min(...[...retries.values()].map(entry => entry.at));
    retryTimer = setTimeout(releaseRetries, Math.max(0, next - Date.now()));
  }

  function releaseRetries() {
    retryTimer = null;
    const now = Date.now();
    let released = false;
    for (const [id, entry] of [...retries]) {
      if (entry.at > now) continue;
      retries.delete(id);
      addPending(id, entry.reason);
      released = true;
    }
    if (released) scheduleFlush();
    armRetry();
  }

  /** Back off a tab that came back unlabelled; give up after the last delay until it navigates. */
  function scheduleRetry(id, reason) {
    const count = (failures.get(id) || 0) + 1;
    failures.set(id, count);
    if (count > retryDelaysMs.length) {
      gaveUp.add(id);
      retries.delete(id);
      return;
    }
    retries.set(id, { at: Date.now() + retryDelaysMs[count - 1], reason });
    armRetry();
  }

  /** A user action (popup open, a cleanup's provisional tabs) gives a given-up tab one more attempt. */
  function revive(id) {
    if (!gaveUp.delete(id)) return;
    failures.set(id, retryDelaysMs.length);
  }

  function forgetLabelState(tabId) {
    failures.delete(tabId);
    gaveUp.delete(tabId);
    retries.delete(tabId);
    labelledAt.delete(tabId);
  }

  function enqueue(tabIds, { reason = 'other', retryGivenUp = false } = {}) {
    const why = REASON_RANK[reason] === undefined ? 'other' : reason;
    const now = Date.now();
    let added = 0;
    for (const id of tabIds || []) {
      if (!Number.isInteger(id)) continue;
      if (retryGivenUp) revive(id);
      if (gaveUp.has(id)) continue;
      const retry = retries.get(id);
      if (retry) {
        // Already waiting for its back-off.
        if (REASON_RANK[why] > REASON_RANK[retry.reason]) retry.reason = why;
        continue;
      }
      if (why === 'title' && now - (labelledAt.get(id) ?? -Infinity) < titleRelabelMs) continue;
      addPending(id, why);
      added++;
    }
    if (added > 0) scheduleFlush();
  }

  async function classifyBatch(batch, signal) {
    let current;
    try {
      current = await scope();
    } catch (error) {
      console.warn('[Foldnex] Could not read background settings:', error?.message);
      return;
    }
    if (!current) return;
    let sendable = batch;
    if (!current.allowed) {
      if (!current.cleanupFollowUp) return;
      sendable = batch.filter(([, reason]) => reason === 'cleanup');
    }
    if (!current.onDevice) {
      // Cloud consent covers pages opened after Auto-group was turned on, never title-only changes.
      const fresh = new Set(await tracker.freshIds());
      sendable = sendable.filter(([id, reason]) => reason !== 'title' && fresh.has(id));
    }
    if (sendable.length === 0) return;
    const ids = sendable.map(([id]) => id);
    const reasonOf = new Map(sendable);

    let result = null;
    let unlabelled = [];
    try {
      result = await classify(ids, signal);
      unlabelled = result?.error
        ? (Array.isArray(result.unlabelledIds) ? result.unlabelledIds : ids)
        : (Array.isArray(result?.unlabelledIds) ? result.unlabelledIds : []);
    } catch (error) {
      if (!signal.aborted) {
        console.warn('[Foldnex] Background classification failed:', error?.message);
        unlabelled = Array.isArray(error?.unlabelledIds) ? error.unlabelledIds : ids;
      }
    }
    if (signal.aborted) {
      for (const [id, reason] of sendable) addPending(id, reason);
      return;
    }

    const now = Date.now();
    for (const id of result?.labelledIds || []) {
      labelledAt.set(id, now);
      failures.delete(id);
    }
    const unlabelledSet = new Set(unlabelled.filter(id => reasonOf.has(id)));
    for (const id of unlabelledSet) scheduleRetry(id, reasonOf.get(id));

    // A candidate that just loaded lets its window auto-group; nothing else does.
    const autoWindows = new Set();
    if (current.autoGroup) {
      const candidates = new Set(await tracker.candidateIds());
      const triggers = sendable
        .filter(([id, reason]) => reason === 'load' && candidates.has(id) && !unlabelledSet.has(id))
        .map(([id]) => id);
      const tabs = await Promise.all(triggers.map(id => chrome.tabs.get(id).catch(() => null)));
      for (const tab of tabs) {
        if (tab && !tab.incognito && (tab.groupId ?? NO_GROUP) === NO_GROUP) autoWindows.add(tab.windowId);
      }
    }
    for (const windowId of new Set([...(result?.storedWindowIds || []), ...autoWindows])) {
      pushRefresh(windowId, autoWindows.has(windowId));
    }
  }

  async function runDueRefreshes(signal) {
    const now = Date.now();
    if (![...refreshDue.values()].some(entry => entry.at <= now)) return;
    // A refresh may prompt for names, so it needs the same opt-in as
    // labelling; a due refresh the settings do not allow is dropped.
    let allowed = false;
    try {
      allowed = Boolean((await scope())?.allowed);
    } catch (error) {
      console.warn('[Foldnex] Could not read background settings:', error?.message);
    }
    for (const [windowId, entry] of [...refreshDue]) {
      if (signal.aborted) break;
      if (entry.at > now) continue;
      refreshDue.delete(windowId);
      if (!allowed) continue;
      try {
        const candidateIds = entry.autoGroup ? await tracker.candidateIds() : [];
        await refresh(windowId, signal, {
          autoGroup: entry.autoGroup,
          candidateIds,
          onGrouped: tabIds => tracker.markGrouped(tabIds)
        });
      } catch (error) {
        if (signal.aborted) {
          if (!refreshDue.has(windowId)) refreshDue.set(windowId, { ...entry, at: Date.now() + refreshDelayMs });
        } else {
          console.warn('[Foldnex] Background plan refresh failed:', error?.message);
        }
      }
    }
  }

  function pause() {
    holds++;
    clearTimeout(flushTimer);
    flushTimer = null;
    clearTimeout(refreshTimer);
    refreshTimer = null;
    running?.abort(new Error('Paused for cleanup'));
  }

  function resume() {
    holds = Math.max(0, holds - 1);
    if (paused()) return;
    scheduleFlush();
    armRefresh();
  }

  /** Settles once the current flush, if any, has finished or stopped. */
  function whenIdle() {
    return running ? idle : Promise.resolve();
  }

  function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    clearTimeout(refreshTimer);
    refreshTimer = null;
    if (paused() || running) return idle;

    const batch = [...pending];
    pending.clear();
    pendingSince = null;
    const controller = new AbortController();
    running = controller;
    idle = (async () => {
      try {
        if (batch.length > 0) await classifyBatch(batch, controller.signal);
        await runDueRefreshes(controller.signal);
      } catch (error) {
        console.warn('[Foldnex] Background queue failed:', error?.message);
      } finally {
        running = null;
        scheduleFlush();
        armRefresh();
      }
    })();
    return idle;
  }

  return {
    enqueue,
    /**
     * Move a window's groupable tabs to the front of the queue (adding any
     * that are not queued) without flushing before the usual debounce. Tabs
     * waiting for a retry keep waiting; a given-up tab gets one more attempt.
     */
    async prioritize(windowId) {
      const tabs = getGroupableTabs(await chrome.tabs.query({ windowId })).filter(tab => !tab.incognito);
      for (const tab of tabs) revive(tab.id);
      const ids = tabs.map(tab => tab.id).filter(id => !retries.has(id));
      if (ids.length === 0) return;
      const rest = [...pending];
      pending.clear();
      for (const id of ids) pending.set(id, 'other');
      for (const [id, reason] of rest) {
        const current = pending.get(id);
        if (current === undefined || REASON_RANK[reason] > REASON_RANK[current]) pending.set(id, reason);
      }
      if (pendingSince === null) pendingSince = Date.now();
      if (!flushTimer && !running) scheduleFlush();
    },
    /** A cleanup's follow-up refresh: it keeps the plan current and never auto-groups. */
    scheduleWindowPlanRefresh(windowId) {
      pushRefresh(windowId, false);
    },
    pendingTabIds() {
      return [...pending.keys()];
    },
    async noteTabCreated(tab, { autoGroup = false } = {}) {
      if (!tab || tab.incognito || !Number.isInteger(tab.id)) return;
      lastPageKey.set(tab.id, pageKey(tab.pendingUrl || tab.url));
      navigatedAt.set(tab.id, Date.now());
      // A tab Chrome restores without loading is not new.
      if (autoGroup && tab.status !== 'unloaded' && !tab.discarded) {
        await tracker.markNew(tab.id, { grouped: (tab.groupId ?? NO_GROUP) !== NO_GROUP });
      }
    },
    async noteTabUpdated(tabId, changeInfo = {}, tab = {}, { autoGroup = false } = {}) {
      if (!Number.isInteger(tabId) || tab?.incognito) return;
      if (Number.isInteger(changeInfo.groupId)) {
        if (changeInfo.groupId === NO_GROUP) await tracker.markTakenOut([[tabId, pageKey(tab?.url)]]);
        else await tracker.markGrouped([tabId]);
      }

      let navigated = false;
      let addressRewritten = false;
      if (typeof changeInfo.url === 'string') {
        const key = pageKey(changeInfo.url);
        const known = (await tracker.outKey(tabId)) ?? lastPageKey.get(tabId);
        lastPageKey.set(tabId, key);
        // A same-document change (fragment, history API, a map rewriting its
        // address as it pans) is never a new page; it is treated like a
        // title change.
        const sameDocument = tab?.status === 'complete' && changeInfo.status !== 'loading';
        if (known !== key && sameDocument) {
          addressRewritten = true;
        } else if (known !== key) {
          navigated = true;
          forgetLabelState(tabId);
          navigatedAt.set(tabId, Date.now());
          if (autoGroup) await tracker.markNew(tabId, { grouped: (tab?.groupId ?? NO_GROUP) !== NO_GROUP });
        }
      }

      const settling = Date.now() - (navigatedAt.get(tabId) ?? -Infinity) < navigationSettleMs;
      if ((changeInfo.status === 'complete' && !addressRewritten) || (navigated && tab?.status === 'complete')) {
        enqueue([tabId], { reason: 'load' });
      } else if ((changeInfo.title || addressRewritten) && tab?.status === 'complete') {
        enqueue([tabId], { reason: settling ? 'load' : 'title' });
      }
    },
    async noteTabRemoved(tabId) {
      pending.delete(tabId);
      forgetLabelState(tabId);
      navigatedAt.delete(tabId);
      lastPageKey.delete(tabId);
      await tracker.forget(tabId);
    },
    /** After Ungroup all: the window's tabs stop being candidates until they open a new page. */
    async noteWindowUngrouped(windowId) {
      if (!Number.isInteger(windowId)) return;
      const tabs = await chrome.tabs.query({ windowId });
      await tracker.markTakenOut(tabs.filter(tab => !tab.incognito).map(tab => [tab.id, pageKey(tab.url)]));
    },
    /** Turning Auto-group off forgets which tabs were new. */
    async setAutoGroup(enabled) {
      if (!enabled) await tracker.clear();
    },
    /**
     * Background work was turned off: stop the current flush and drop every
     * queued tab, pending retry and plan refresh. Waits up to `waitMs` for
     * the stopped flush to hand its work back, so none of it survives.
     */
    async clear({ waitMs = 1000 } = {}) {
      pause();
      let timer = null;
      try {
        await Promise.race([whenIdle(), new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
      } finally {
        clearTimeout(timer);
        pending.clear();
        pendingSince = null;
        retries.clear();
        clearTimeout(retryTimer);
        retryTimer = null;
        refreshDue.clear();
        resume();
      }
    },
    pause,
    resume,
    whenIdle
  };
}
