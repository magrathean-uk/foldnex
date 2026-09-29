/**
 * Foldnex - Group Orchestrator
 * Connects tab querying, the label caches, model labelling, the local
 * planner, and the native Chrome tabGroups API. Models only label tabs (and
 * optionally name finished groups); the planner decides every group.
 */

import {
  ExactResultCache,
  LearningCache,
  PlanMemory,
  TabLabelCache,
  WindowPlanStore,
  fingerprintTab
} from './cache-engine.js';
import {
  assessGroupingQuality,
  checkChromeNanoStatus,
  CHROME_GROUP_COLORS,
  cloudLabelBatchSize,
  consolidateWithCloud,
  getEffectiveReasoningEffort,
  getNanoBase,
  groupCeiling,
  isNamingEligible,
  labelBatchWithNano,
  labelTabsWithAI,
  nameGroupsWithNano,
  NANO_MAX_BATCH,
  NANO_PERF_DEFAULTS,
  PROVIDER_CATALOG,
  providerSettingKey,
  readNanoPerf,
  updateNanoPerf
} from './ai-engine.js';
import {
  buildLocalContext,
  categoryFromSite,
  enforceFolders,
  enforceGroupCeiling,
  ensureUniqueNames,
  groupTokenHashes,
  inferLocalLabel,
  labelPriority,
  planGroups,
  planSignature,
  REVIEW_GROUP_NAME,
  transferNames,
  validateGroupName
} from './planner.js';
import { clusterTabsBySite, isSocialSite } from './site-clusterer.js';
import { markProgrammaticGroupUpdate } from './group-state.js';
import { createTrace, noopTrace } from './debug-trace.js';

const RUN_HISTORY_KEY = 'foldnex_run_history_v1';
const RUN_HISTORY_LIMIT = 20;
const PROMPT_VERSION = 'labels-v1';
const SAFE_INTERNAL_DUPLICATE_PAGES = new Set([
  'extensions', 'downloads', 'history', 'bookmarks'
]);

// One deadline governs a click. Model work stops APPLY_RESERVE_MS before it
// so the strip is always regrouped on time; late answers only fill caches.
export const CLICK_BUDGET_MS = 4500;
export const APPLY_RESERVE_MS = 600;
export const NANO_LOAD_RACE_MS = 1500;
export const NAMING_MIN_REMAINING_MS = 2500;
export const CONSOLIDATION_MIN_REMAINING_MS = 1500;
// Owner decision pending: By site category keeps its 15-30 group contract.
export const APPLY_CEILING_TO_SITE_MODE = false;

// A cold model load may not eat the time the label prompts need.
const NANO_LOAD_LABEL_RESERVE_MS = 3000;
// After label prompts, a naming prompt only fits with this much left.
const NAMING_AFTER_LABELS_MIN_REMAINING_MS = 3000;
// Fewer tabs than this per prompt costs more in overhead than it labels.
const MIN_CLICK_BATCH = 4;
const NANO_LOADING = Object.freeze({
  code: 'nano_loading',
  detail: 'The on-device model is still loading',
  used: false
});

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
  const provider = settings.provider || 'gemini_nano';
  const config = PROVIDER_CATALOG[provider] || PROVIDER_CATALOG.gemini_nano;
  if (provider === 'gemini_api') return settings.geminiModel || config.defaultModel || 'gemini';
  if (config.mode === 'compatible') {
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

function combineMeta(metas, parallel) {
  const present = metas.filter(Boolean);
  if (present.length === 0) return null;
  const sum = key => present.reduce((total, meta) => total + Number(meta.usage?.[key] || 0), 0);
  const reasoning = present.map(meta => meta.usage?.reasoningTokens);
  const latencies = present.map(meta => Number(meta.latencyMs || 0));
  return {
    ...present.at(-1),
    latencyMs: parallel ? Math.max(...latencies) : latencies.reduce((a, b) => a + b, 0),
    calls: present.reduce((total, meta) => total + Number(meta.calls || 0), 0),
    usage: {
      promptTokens: sum('promptTokens'),
      completionTokens: sum('completionTokens'),
      totalTokens: sum('totalTokens'),
      cachedTokens: sum('cachedTokens'),
      reasoningTokens: reasoning.every(Number.isFinite) ? reasoning.reduce((a, b) => a + b, 0) : null
    }
  };
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
  const message = String(error?.message || '');
  if (/429|quota/i.test(message)) return { code: 'quota', detail: 'Provider quota or rate limit reached' };
  if (/401|API key/i.test(message)) return { code: 'auth', detail: 'Provider authentication failed' };
  if (/timed out|abort/i.test(message)) return { code: 'timeout', detail: 'Provider timed out' };
  if (/Nano|Prompt API/i.test(message)) return { code: 'nano_unavailable', detail: 'Chrome local model unavailable' };
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

export async function loadGroupingSettings() {
  const [syncSettings, localSecrets] = await Promise.all([
    chrome.storage.sync.get(),
    chrome.storage.local.get([
      'geminiApiKey', 'openaiApiKey', 'openaiOAuthToken',
      'xaiApiKey', 'groqApiKey', 'openrouterApiKey',
      'deepseekApiKey', 'cerebrasApiKey', 'ollamaApiKey'
    ])
  ]);
  return { ...syncSettings, ...localSecrets };
}

/** Engine, strategy, and the cache scope that results for them are stored under. */
export function getRunScope(settings) {
  const provider = settings.provider || 'gemini_nano';
  const requestedModel = modelForSettings(settings);
  const groupingStrategy = settings.groupingStrategy === 'site' ? 'site' : 'task';
  const savedReasoningEffort = provider === 'gemini_api'
    ? settings.geminiReasoningEffort
    : settings[providerSettingKey(provider, 'reasoningEffort')];
  const effectiveReasoningEffort = groupingStrategy === 'task'
    ? getEffectiveReasoningEffort(provider, requestedModel, savedReasoningEffort)
    : null;
  return {
    provider,
    requestedModel,
    groupingStrategy,
    effectiveReasoningEffort,
    cacheScope: `${PROMPT_VERSION}:${groupingStrategy}:${provider}:${requestedModel}:${effectiveReasoningEffort || 'none'}`
  };
}

/** Engines that run on this device: Nano, offline smart mode and Ollama. */
export function isLocalEngine(provider) {
  const id = provider || 'gemini_nano';
  return id === 'gemini_nano' || id === 'offline' || PROVIDER_CATALOG[id]?.local === true;
}

const CLOUD_ENGINE_IDS = Object.freeze(Object.keys(PROVIDER_CATALOG).filter(id => (
  !isLocalEngine(id) && (id === 'gemini_api' || PROVIDER_CATALOG[id].mode === 'compatible')
)));

/**
 * Which cached labels an engine may reuse: every label for local engines, only
 * cloud-written labels for a cloud engine, so a cloud user never silently gets
 * Nano-quality labels.
 */
export function acceptEnginesFor(provider) {
  return isLocalEngine(provider) ? null : CLOUD_ENGINE_IDS;
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

/** Settle with the promise's outcome, or with 'timeout' after ms, never rejecting. */
function settleWithin(promise, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ state: 'timeout' }), Math.max(0, Number(ms) || 0));
    Promise.resolve(promise).then(value => {
      clearTimeout(timer);
      resolve({ state: 'fulfilled', value });
    }, reason => {
      clearTimeout(timer);
      resolve({ state: 'rejected', reason });
    });
  });
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

function emptyLabelling() {
  return { labels: new Map(), meta: null, deadlineHit: false, fallback: null };
}

async function labelWithNanoOnClick(missing, { budget, trace, incognito }) {
  const startedAt = performance.now();
  const labels = new Map();
  let calls = 0;
  const finish = (fields = {}) => ({
    ...emptyLabelling(),
    labels,
    meta: {
      provider: 'gemini_nano',
      model: 'chrome-gemini-nano',
      usage: null,
      latencyMs: Math.round(performance.now() - startedAt),
      calls,
      reasoningEffort: null
    },
    ...fields
  });

  const status = await settleWithin(checkChromeNanoStatus(), budget.remaining() - APPLY_RESERVE_MS);
  if (status.state === 'timeout') return finish({ fallback: NANO_LOADING });
  if (status.value?.status !== 'ready') {
    trace.mark('nano_status_unavailable', { status: status.value?.status || 'unknown' });
    return finish({ fallback: { code: 'nano_unavailable', detail: 'Chrome local model unavailable', used: true } });
  }

  // A cold load (15-19 s) never belongs to a click: give up quickly and let
  // it finish for the background, which reuses the same pending load.
  const load = await settleWithin(
    getNanoBase('label'),
    Math.min(NANO_LOAD_RACE_MS, budget.remaining() - NANO_LOAD_LABEL_RESERVE_MS)
  );
  if (load.state === 'timeout') {
    trace.mark('nano_loading');
    return finish({ fallback: NANO_LOADING });
  }
  if (load.state === 'rejected') {
    trace.mark('nano_load_failed');
    return finish({ fallback: { code: 'nano_unavailable', detail: 'Chrome local model unavailable', used: true } });
  }

  // Incognito never reads or writes the stored speed estimate.
  let perf = incognito ? { ...NANO_PERF_DEFAULTS } : await readNanoPerf();
  const signal = budget.abortAt(APPLY_RESERVE_MS);
  let deadlineHit = false;
  let fallback = null;
  let offset = 0;
  while (offset < missing.length) {
    const fits = Math.floor((budget.remaining() - APPLY_RESERVE_MS - perf.overheadMs) / perf.msPerTab);
    const count = Math.min(NANO_MAX_BATCH, Math.max(0, fits));
    if (count < MIN_CLICK_BATCH) {
      deadlineHit = true;
      break;
    }
    const batch = missing.slice(offset, offset + count);
    calls++;
    try {
      const result = await labelBatchWithNano(batch, { signal, trace });
      for (const [tabId, key] of result.labels) labels.set(tabId, key);
      offset += Math.max(1, result.count);
      if (!incognito) perf = (await updateNanoPerf({ count: result.count, elapsedMs: result.ms })) || perf;
    } catch (error) {
      if (signal.aborted) deadlineHit = true;
      else fallback = { ...classifyProviderFailure(error), used: true };
      break;
    }
  }
  return finish({ deadlineHit, fallback });
}

async function labelWithProviderOnClick(missing, settings, { budget, trace, incognito, fingerprintById }) {
  const startedAt = performance.now();
  const provider = settings?.provider;
  const landed = new Map();
  const landedMeta = [];
  let waiting = true;
  // One request up to 40 tabs, otherwise parallel batches of 25. At the
  // deadline the click stops waiting but does not abort them: the provider's
  // own timeout bounds each request, and a batch that lands late is stored in
  // the label cache for the next click. Incognito never stores a late label,
  // so its requests stop at the deadline (or are not sent without time left).
  const request = labelTabsWithAI(missing, settings, {
    signal: incognito ? budget.abortAt(APPLY_RESERVE_MS) : null,
    trace,
    onBatch: (labels, info) => {
      if (waiting) {
        for (const [id, key] of labels) landed.set(id, key);
        landedMeta.push({ usage: info?.usage || null, latencyMs: info?.ms, calls: 1 });
        return null;
      }
      if (incognito || !(fingerprintById instanceof Map) || labels.size === 0) return null;
      return TabLabelCache.store(labels, fingerprintById, provider);
    }
  });
  const outcome = await settleWithin(request, budget.remaining() - APPLY_RESERVE_MS);
  waiting = false;

  if (outcome.state === 'fulfilled') {
    const result = outcome.value;
    return {
      labels: result.labels,
      meta: result.meta,
      deadlineHit: Boolean(result.aborted),
      fallback: result.error ? { ...classifyProviderFailure(result.error), used: true } : null
    };
  }
  if (outcome.state === 'rejected') {
    return { ...emptyLabelling(), fallback: { ...classifyProviderFailure(outcome.reason), used: true } };
  }

  // settleWithin already handles a later rejection of `request`.
  trace.mark('labels_deadline', { landed: landed.size, missing: missing.length });
  const labels = new Map();
  for (const tab of missing) {
    if (landed.has(tab.id)) labels.set(tab.id, landed.get(tab.id));
  }
  return {
    labels,
    meta: {
      provider,
      model: null,
      reasoningEffort: null,
      ...combineMeta(landedMeta, true),
      latencyMs: Math.round(performance.now() - startedAt),
      calls: Math.ceil(missing.length / cloudLabelBatchSize(missing.length))
    },
    deadlineHit: true,
    fallback: null
  };
}

/**
 * Label the tabs the caches missed, within the click budget. Nano labels in
 * batches sized by the stored speed estimate and aborts at the deadline, so
 * the model is free for the next prompt. Cloud and Ollama send one request
 * (or parallel batches) that the click stops waiting for at the deadline;
 * batches that land later are stored in TabLabelCache under `fingerprintById`.
 * An incognito click aborts them at the deadline instead.
 * @returns {Promise<{labels: Map<number, string>, meta: object|null, deadlineHit: boolean, fallback: {code, detail, used}|null}>}
 */
export async function labelOnClick(missing, settings, {
  budget,
  trace = noopTrace,
  incognito = false,
  fingerprintById = null
} = {}) {
  const provider = settings?.provider || 'gemini_nano';
  if (!missing?.length || provider === 'offline') return emptyLabelling();
  const clickBudget = budget || createClickBudget(CLICK_BUDGET_MS);
  if (provider === 'gemini_nano') return labelWithNanoOnClick(missing, { budget: clickBudget, trace, incognito });
  return labelWithProviderOnClick(missing, settings, { budget: clickBudget, trace, incognito, fingerprintById });
}

function isLockedPlanGroup(group) {
  return group?.locked === true || group?.kind === 'rule' || group?.kind === 'social';
}

function isReviewPlanGroup(group) {
  return group?.kind === 'review' || String(group?.name || '').toLowerCase() === REVIEW_GROUP_NAME.toLowerCase();
}

/**
 * Groups a model may name, and whether memory already named at least half of
 * them (then no naming or consolidation call is worth making).
 */
export function namingNeed(groups) {
  const eligible = (groups || []).filter(group => isNamingEligible({ ...group, nameSource: 'deterministic' }));
  const remembered = eligible.filter(group => /^memory-/.test(String(group.nameSource || '')));
  return {
    eligible,
    toName: eligible.filter(group => !remembered.includes(group)),
    needed: eligible.length > 0 && remembered.length * 2 < eligible.length
  };
}

/**
 * Apply validated model names in place. `rawNames` maps an index in
 * `targets` to the raw answer. Returns PlanMemory records for the names used.
 */
export function applyModelNames(targets, rawNames, groups, { tabsById = null, tokensById = null, source = 'nano' } = {}) {
  const records = [];
  for (const [index, raw] of rawNames || []) {
    const group = targets[index];
    if (!group) continue;
    const taken = (groups || []).filter(other => other !== group).map(other => other.name);
    const name = validateGroupName(raw, group, tabsById, taken);
    if (!name) continue;
    group.name = name;
    group.nameSource = 'model';
    records.push({ k: group.keys || [], w: groupTokenHashes(group, tokensById), n: name, c: group.color, s: source });
  }
  return records;
}

/**
 * A consolidation answer worth applying. An empty or unparseable answer is
 * ignored: enforceFolders would otherwise pair every missing row with its
 * neighbour and merge groups nobody asked to merge.
 */
export function hasFolders(result) {
  return Array.isArray(result?.folders) && result.folders.length > 0;
}

/** Folder limit for consolidation: the ceiling minus locked groups and Review Later. */
export function consolidationLimit(plan, groups) {
  const lockedCount = (groups || []).filter(isLockedPlanGroup).length;
  const review = (groups || []).some(isReviewPlanGroup) ? 1 : 0;
  return Math.max(1, (plan?.K || 1) - lockedCount - review);
}

/**
 * Replace a plan's unlocked groups with consolidation folders made safe by
 * enforceFolders. User renames still win over the model's folder names.
 * Returns {groups, advice, records} for display and PlanMemory.
 */
export function applyFolders(groups, plan, folders, k, { tabsById = null, memory = null, fingerprintById = null } = {}) {
  const locked = (groups || []).filter(isLockedPlanGroup);
  const review = (groups || []).filter(group => !isLockedPlanGroup(group) && isReviewPlanGroup(group));
  const { groups: folderGroups, advice } = enforceFolders(folders, plan.candidates, k, {
    n: plan.n,
    tabsById,
    takenNames: [...locked.map(group => group.name), REVIEW_GROUP_NAME]
  });
  const records = folderGroups
    .filter(group => group.nameSource === 'model')
    .map(group => ({ k: group.keys, w: groupTokenHashes(group, plan.tokensById), n: group.name, c: group.color, s: 'cloud' }));
  const userMemory = memory ? { names: (memory.names || []).filter(record => record.s === 'user') } : null;
  const named = transferNames(folderGroups, userMemory, { tabsById, tokensById: plan.tokensById, fingerprintById });
  return {
    groups: ensureUniqueNames([...locked, ...named, ...review], locked, { tabsById }),
    advice,
    records
  };
}

function sortByLabelPriority(tabs, ctx) {
  return tabs
    .map((tab, position) => ({ tab, position, priority: labelPriority(tab, ctx) }))
    .sort((a, b) => a.priority - b.priority || a.position - b.position)
    .map(entry => entry.tab);
}

/**
 * Click steps C5-C9: cached labels, click-time labelling, local inference for
 * the rest, the plan, remembered names and optional model naming or cloud
 * consolidation. Pure of Chrome group changes; persistence is returned in
 * `persist` for the caller to write after the strip is regrouped.
 */
export async function groupByLabels(groupableTabs, locked, settings, {
  budget = null,
  trace = noopTrace,
  windowId = null,
  incognito = false,
  provider = settings?.provider || 'gemini_nano'
} = {}) {
  const clickBudget = budget || createClickBudget(CLICK_BUDGET_MS);
  const lockedIds = new Set((locked || []).flatMap(group => group.tabIds || []));
  const pool = groupableTabs.filter(tab => !lockedIds.has(tab.id));
  const tabsById = new Map(groupableTabs.map(tab => [tab.id, tab]));
  const offline = provider === 'offline';
  const labelSources = { cache: 0, model: 0, siteAffinity: 0, site: 0, lexicon: 0, tokenAttach: 0, review: 0 };
  const modelCalls = { label: 0, naming: 0, consolidation: 0 };
  const qualityFlags = [];
  const persist = { labels: new Map(), fingerprintById: new Map(), names: [], advice: null };
  let deadlineHit = false;

  // C5: cached labels. Incognito and the offline engine never read them.
  let lookup = { labels: new Map(), missing: pool, fingerprintById: new Map() };
  if (!incognito && !offline) {
    lookup = await TabLabelCache.lookup(pool, { acceptEngines: acceptEnginesFor(provider) });
  } else if (!incognito) {
    // Offline runs still need fingerprints so user renames stick.
    const fingerprints = await Promise.all(pool.map(fingerprintTab));
    lookup.fingerprintById = new Map(pool.map((tab, index) => [tab.id, fingerprints[index]]));
  }
  const fingerprintById = lookup.fingerprintById;
  persist.fingerprintById = fingerprintById;

  const labelsById = new Map();
  for (const [id, entry] of lookup.labels) labelsById.set(id, { c: entry.c, src: 'cache' });
  labelSources.cache = labelsById.size;
  trace.mark('label_cache', { cached: labelsById.size, missing: lookup.missing.length });

  // C6: label what the caches missed, lowest local confidence first.
  let labelled = emptyLabelling();
  if (!offline && lookup.missing.length > 0) {
    const missing = sortByLabelPriority(lookup.missing, buildLocalContext(pool, labelsById));
    labelled = await labelOnClick(missing, settings, { budget: clickBudget, trace, incognito, fingerprintById });
    trace.mark('labels_done', { labelled: labelled.labels.size, deadlineHit: labelled.deadlineHit });
  }
  for (const [id, key] of labelled.labels) labelsById.set(id, { c: key, src: 'model' });
  labelSources.model = labelled.labels.size;
  modelCalls.label = Number(labelled.meta?.calls || 0);
  deadlineHit = labelled.deadlineHit;
  persist.labels = labelled.labels;
  const fallback = labelled.fallback;

  // C7: every tab still without a model label is placed locally for now.
  const ctx = buildLocalContext(pool, labelsById);
  const provisionalTabIds = [];
  const looseIds = new Set();
  for (const tab of pool) {
    if (labelsById.has(tab.id)) continue;
    // Offline results are final: no engine will sort these tabs later.
    if (!offline) provisionalTabIds.push(tab.id);
    const inferred = inferLocalLabel(tab, ctx);
    if (!inferred) {
      looseIds.add(tab.id);
      continue;
    }
    labelsById.set(tab.id, inferred);
    if (inferred.src === 'site-affinity') labelSources.siteAffinity++;
    else if (inferred.src === 'site') labelSources.site++;
    else labelSources.lexicon++;
  }

  // C8: plan within the ceiling, then remembered names.
  const memory = incognito ? null : await PlanMemory.read();
  const plan = planGroups(pool, labelsById, { locked, advice: memory?.advice?.cloud || null });
  for (const flag of plan.flags) qualityFlags.push(flag);
  let groups = transferNames(plan.groups, memory, { tabsById, tokensById: plan.tokensById, fingerprintById });
  groups = ensureUniqueNames(groups, locked, { tabsById });
  trace.mark('planned', { groups: groups.length, K: plan.K, provisional: provisionalTabIds.length });

  for (const group of groups) {
    for (const id of group.tabIds) {
      if (!looseIds.has(id)) continue;
      if (group.kind === 'review') labelSources.review++;
      else if (group.kind === 'site') labelSources.site++;
      else labelSources.tokenAttach++;
    }
  }

  // C9: model names only when memory named fewer than half of the groups.
  let meta = labelled.meta;
  const need = namingNeed(groups);
  const canName = !offline && !fallback && need.needed;
  // Consolidation needs two candidates; with fewer, no click would ever name them.
  const namingPossible = provider === 'gemini_nano' || plan.candidates.length >= 2;
  let namesApplied = false;
  if (canName && provider === 'gemini_nano') {
    const remaining = clickBudget.remaining();
    const labelPromptRan = modelCalls.label > 0;
    if (remaining >= NAMING_MIN_REMAINING_MS && (!labelPromptRan || remaining >= NAMING_AFTER_LABELS_MIN_REMAINING_MS)) {
      const targets = need.toName;
      modelCalls.naming = 1;
      const request = nameGroupsWithNano(targets, tabsById, { trace });
      const outcome = await settleWithin(request, clickBudget.remaining() - APPLY_RESERVE_MS);
      if (outcome.state === 'fulfilled') {
        const records = applyModelNames(targets, outcome.value, groups, { tabsById, tokensById: plan.tokensById });
        persist.names.push(...records);
        namesApplied = records.length > 0;
      } else if (outcome.state === 'timeout') {
        qualityFlags.push('naming_timeout');
        deadlineHit = true;
        // A late answer is remembered for the next click, never applied now.
        const snapshot = groups.map(group => ({ ...group }));
        const lateTargets = targets.map(group => snapshot[groups.indexOf(group)]);
        if (!incognito) {
          request.then(raw => {
            const records = applyModelNames(lateTargets, raw, snapshot, { tabsById, tokensById: plan.tokensById });
            return records.length ? PlanMemory.putNames(records) : null;
          }).catch(() => {});
        }
      }
    }
  } else if (canName && clickBudget.remaining() >= CONSOLIDATION_MIN_REMAINING_MS && plan.candidates.length >= 2) {
    const k = consolidationLimit(plan, groups);
    modelCalls.consolidation = 1;
    const request = consolidateWithCloud(plan.candidates, k, settings, { trace, tabsById });
    const outcome = await settleWithin(request, clickBudget.remaining() - APPLY_RESERVE_MS);
    if (outcome.state === 'fulfilled' && hasFolders(outcome.value)) {
      const applied = applyFolders(groups, plan, outcome.value.folders, k, { tabsById, memory, fingerprintById });
      groups = applied.groups;
      persist.names.push(...applied.records);
      persist.advice = applied.advice;
      meta = combineMeta([meta, outcome.value.meta], false);
      namesApplied = true;
    } else if (outcome.state !== 'timeout') {
      qualityFlags.push('consolidation_failed');
    } else {
      qualityFlags.push('consolidation_timeout');
      deadlineHit = true;
      const baseGroups = groups.map(group => ({ ...group }));
      if (!incognito) {
        request.then(result => {
          if (!hasFolders(result)) return null;
          const late = applyFolders(baseGroups, plan, result.folders, k, { tabsById, memory, fingerprintById });
          return Promise.all([
            late.records.length ? PlanMemory.putNames(late.records) : null,
            PlanMemory.putAdvice(late.advice)
          ]);
        }).catch(() => {});
      }
    }
  }

  let source;
  if (offline) source = 'offline';
  else if (fallback?.used && labelled.labels.size === 0) source = 'offline-fallback';
  else if (lookup.missing.length === 0) source = 'label-cache';
  else source = provider === 'gemini_nano' ? 'nano' : 'cloud';

  return {
    groups,
    source,
    meta,
    provisionalTabIds,
    labelSources,
    modelCalls,
    deadlineHit,
    // Naming was due but skipped, failed or applied nothing: these
    // deterministic names must not be reused by the exact cache.
    namingPending: canName && namingPossible && !namesApplied,
    fallbackCode: fallback?.code || null,
    fallbackUsed: Boolean(fallback?.used),
    fallbackReason: fallback?.detail || null,
    plan,
    qualityFlags,
    persist,
    windowId
  };
}

function membershipKey(tabIds) {
  return [...(tabIds || [])].sort((a, b) => a - b).join(',');
}

/**
 * C4 (part): an exact-cache hit keeps its membership but takes names that
 * PlanMemory learned since it was stored. The pool is re-planned from cached
 * labels and local inference, with no model call; a cached group whose tabs
 * exactly match a planned group that memory named takes that name, unless
 * another group already holds it.
 */
async function overlayRememberedNames(groups, tabs, locked, provider, context = null) {
  const memory = await PlanMemory.read();
  if (memory.names.length === 0) return groups;

  const lockedIds = new Set((locked || []).flatMap(group => group.tabIds || []));
  const pool = tabs.filter(tab => !lockedIds.has(tab.id));
  const labelsById = new Map();
  if (provider !== 'offline') {
    const lookup = await TabLabelCache.lookup(pool, { acceptEngines: acceptEnginesFor(provider) });
    for (const [id, entry] of lookup.labels) labelsById.set(id, { c: entry.c, src: 'cache' });
  }
  const ctx = buildLocalContext(pool, labelsById);
  for (const tab of pool) {
    if (labelsById.has(tab.id)) continue;
    const inferred = inferLocalLabel(tab, ctx);
    if (inferred) labelsById.set(tab.id, inferred);
  }

  const plan = planGroups(pool, labelsById, { locked, advice: memory.advice?.cloud || null });
  const tabsById = new Map(tabs.map(tab => [tab.id, tab]));
  const fingerprintById = new Map((context?.entries || []).map(entry => [entry.tab.id, entry.fingerprint]));
  const remembered = new Map();
  for (const group of transferNames(plan.groups, memory, { tabsById, tokensById: plan.tokensById, fingerprintById })) {
    if (/^memory-/.test(String(group.nameSource || ''))) remembered.set(membershipKey(group.tabIds), group);
  }
  if (remembered.size === 0) return groups;

  const taken = new Set(groups.map(group => String(group.name || '').toLowerCase()));
  return groups.map(group => {
    const match = remembered.get(membershipKey(group.tabIds));
    if (!match || match.name === group.name || taken.has(match.name.toLowerCase())) return group;
    taken.delete(String(group.name || '').toLowerCase());
    taken.add(match.name.toLowerCase());
    return {
      ...group,
      name: match.name,
      color: match.nameSource === 'memory-user' ? match.color : group.color,
      nameSource: match.nameSource
    };
  });
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
export async function executeTabGrouping(windowId, settings, { budgetMs = CLICK_BUDGET_MS } = {}) {
  const budget = createClickBudget(budgetMs);
  try {
    return await groupWindow(windowId, settings, budget, budgetMs);
  } finally {
    budget.dispose();
  }
}

async function groupWindow(windowId, settings, budget, budgetMs) {
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

  const effectiveSettings = settings || await loadGroupingSettings();
  let fallbackUsed = false;
  let fallbackReason = null;
  let fallbackCode = null;
  let resultSource = 'unknown';
  let aiMeta = null;
  let qualityIssues = [];
  let qualityCodes = [];
  let provisionalTabIds = [];
  let deadlineHit = false;
  let namingPending = false;
  let labelSources = { cache: 0, model: 0, siteAffinity: 0, site: 0, lexicon: 0, tokenAttach: 0, review: 0 };
  let modelCalls = { label: 0, naming: 0, consolidation: 0 };
  let persist = null;
  let planForStore = null;
  let exactCacheToWrite = null;

  if (!isIncognitoWindow) await LearningCache.ensureSchema();
  const { provider, requestedModel, groupingStrategy, effectiveReasoningEffort, cacheScope } = getRunScope(effectiveSettings);
  const n = groupableTabs.length;
  const ceiling = groupCeiling(n);

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
        finalGroups = await overlayRememberedNames(cached.groups, groupableTabs, locked, provider, cached.context);
        resultSource = 'exact-cache';
        console.log(`[Foldnex] Reused an exact result for ${n} unchanged tabs.`);
      }
    }

    let plan = null;
    if (finalGroups.length === 0) {
      const outcome = await groupByLabels(groupableTabs, locked, effectiveSettings, {
        budget,
        trace,
        windowId: resolvedWindowId,
        incognito: isIncognitoWindow,
        provider
      });
      finalGroups = outcome.groups;
      resultSource = outcome.source;
      aiMeta = outcome.meta;
      provisionalTabIds = outcome.provisionalTabIds;
      deadlineHit = outcome.deadlineHit;
      namingPending = outcome.namingPending;
      labelSources = outcome.labelSources;
      modelCalls = outcome.modelCalls;
      fallbackCode = outcome.fallbackCode;
      fallbackUsed = outcome.fallbackUsed;
      fallbackReason = outcome.fallbackReason;
      qualityIssues = [...outcome.qualityFlags];
      persist = outcome.persist;
      plan = outcome.plan;
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
    finalGroups = enforceGroupCeiling(finalGroups, { ceiling, protectedNames: lockedNames });

    const quality = assessGroupingQuality(finalGroups, groupableTabs);
    qualityIssues = [...new Set([...qualityIssues, ...quality.issues])];
    qualityCodes = quality.codes;
    planForStore = {
      K: ceiling,
      signature: plan?.signature || planSignature(finalGroups),
      groups: finalGroups
    };

    // C12 (part): the exact cache holds only final, fully labelled and named results.
    const cacheable = resultSource !== 'exact-cache'
      && provisionalTabIds.length === 0
      && !fallbackUsed
      && !fallbackCode
      && !deadlineHit
      && !namingPending;
    if (!isIncognitoWindow && cacheable) {
      exactCacheToWrite = exactCacheContext || await ExactResultCache.makeContext(groupableTabs, cacheScope);
    }
  }

  trace.mark('groups_ready', { groups: finalGroups.length, source: resultSource });

  // Tab strip ordering & anti-thrashing
  // Re-verify current live tabs to prevent "No tab with id" errors during async gap
  const currentLiveTabs = await chrome.tabs.query({ windowId: resolvedWindowId });
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
        createProperties: { windowId: resolvedWindowId }
      });

      // Register in shared session state before the title event reaches the
      // background worker's rename listener.
      await markProgrammaticGroupUpdate(groupId, grp.name);

      await chrome.tabGroups.update(groupId, {
        title: grp.name,
        color: assignedColor,
        collapsed: Boolean(effectiveSettings.collapseGroupsOnCreation)
      });

      groupsCreatedCount++;
    } catch (err) {
      console.warn(`[Foldnex] Retrying group "${grp.name}" due to tab state change:`, err);
      try {
        const survivingIds = [];
        for (const id of validTabIds) {
          try {
            const t = await chrome.tabs.get(id);
            if (t && t.windowId === resolvedWindowId && !t.pinned) survivingIds.push(id);
          } catch { /* Tab was closed */ }
        }
        if (survivingIds.length > 0) {
          const groupId = await chrome.tabs.group({
            tabIds: survivingIds,
            createProperties: { windowId: resolvedWindowId }
          });
          await markProgrammaticGroupUpdate(groupId, grp.name);
          await chrome.tabGroups.update(groupId, {
            title: grp.name,
            color: assignedColor,
            collapsed: Boolean(effectiveSettings.collapseGroupsOnCreation)
          });
          groupsCreatedCount++;
        }
      } catch (retryErr) {
        console.error(`[Foldnex] Final failure for group "${grp.name}":`, retryErr);
      }
    }
  }

  trace.mark('groups_applied', { created: groupsCreatedCount });

  // C12: persist after the strip is regrouped. Model labels and names only;
  // provisional placements and deterministic names are never stored.
  if (!isIncognitoWindow && groupingStrategy === 'task') {
    if (persist?.labels.size > 0) await TabLabelCache.store(persist.labels, persist.fingerprintById, provider);
    if (persist?.names.length > 0) await PlanMemory.putNames(persist.names);
    if (persist?.advice && Object.keys(persist.advice).length > 0) await PlanMemory.putAdvice(persist.advice);
    if (planForStore) await WindowPlanStore.put(resolvedWindowId, planForStore);
    if (exactCacheToWrite) await ExactResultCache.put(exactCacheToWrite, finalGroups);
  }

  const nameSources = countNameSources(finalGroups);

  // Record privacy-safe diagnostics. Raw titles, URLs, prompts, and provider
  // response bodies are intentionally excluded.
  if (!isIncognitoWindow) {
    const now = Date.now();
    const usage = aiMeta?.usage || {};
    const reportedReasoningTokens = Number.isFinite(usage.reasoningTokens) ? usage.reasoningTokens : null;
    const recordedReasoningEffort = resultSource === 'cloud'
      ? aiMeta?.reasoningEffort || effectiveReasoningEffort
      : null;
    await recordRun({
      timestamp: now,
      groupsCreated: groupsCreatedCount,
      tabsGrouped: n,
      duplicateTabsClosed,
      strategy: groupingStrategy,
      provider,
      model: groupingStrategy === 'task' ? aiMeta?.model || requestedModel : null,
      reasoningEffort: recordedReasoningEffort,
      source: resultSource,
      promptVersion: PROMPT_VERSION,
      promptTokens: Number(usage.promptTokens || 0),
      completionTokens: Number(usage.completionTokens || 0),
      cachedTokens: Number(usage.cachedTokens || 0),
      reasoningTokens: reportedReasoningTokens,
      latencyMs: Math.round(performance.now() - runStartedAt),
      providerLatencyMs: Number(aiMeta?.latencyMs || 0),
      qualityFlags: qualityIssues,
      fallbackCode,
      fallbackDetail: fallbackReason,
      groupCeiling: ceiling,
      provisionalTabs: provisionalTabIds.length,
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
      : fallbackUsed
        ? `Organized ${n} tabs into ${groupsCreatedCount} groups using Offline Smart Mode (AI unavailable/blocked).`
        : `Successfully organized ${n} tabs into ${groupsCreatedCount} groups!`,
    groupsCreated: groupsCreatedCount,
    totalTabs: n,
    duplicateTabsClosed,
    strategy: groupingStrategy,
    source: resultSource,
    model: groupingStrategy === 'task' ? aiMeta?.model || requestedModel : null,
    reasoningEffort: resultSource === 'cloud' ? aiMeta?.reasoningEffort || effectiveReasoningEffort : null,
    reasoningTokens: Number.isFinite(aiMeta?.usage?.reasoningTokens) ? aiMeta.usage.reasoningTokens : null,
    qualityFlags: qualityIssues,
    qualityCodes,
    groups: finalGroups,
    groupCeiling: ceiling,
    provisionalTabIds,
    provisionalTabs: provisionalTabIds.length,
    nameSources,
    deadlineHit,
    windowId: resolvedWindowId,
    incognito: isIncognitoWindow
  };
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
