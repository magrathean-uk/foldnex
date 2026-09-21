/**
 * Foldnex - Group Orchestrator
 * Connects tab querying, local learning cache, AI clustering, and native Chrome tabGroups API.
 */

import { ExactResultCache, LearningCache } from './cache-engine.js';
import {
  assessGroupingQuality,
  clusterTabsWithAI,
  CHROME_GROUP_COLORS,
  PROVIDER_CATALOG,
  providerSettingKey
} from './ai-engine.js';
import { clusterTabsOffline } from './offline-clusterer.js';
import { clusterTabsBySite, isSocialSite } from './site-clusterer.js';
import { markProgrammaticGroupUpdate } from './group-state.js';

const RUN_HISTORY_KEY = 'foldnex_run_history_v1';
const RUN_HISTORY_LIMIT = 20;
const PROMPT_VERSION = 'semantic-v7';
const SAFE_INTERNAL_DUPLICATE_PAGES = new Set([
  'extensions', 'downloads', 'history', 'bookmarks'
]);

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

/**
 * Keep public social services out of misleading task groups such as
 * "System & Admin". This runs before explicit local rules, so a user's own
 * mapping remains authoritative.
 */
function enforceSocialGroup(groups, tabs) {
  const socialTabs = (tabs || []).filter(tab => isSocialSite(tab.url || tab.pendingUrl || ''));
  if (socialTabs.length === 0) return groups || [];

  const socialIds = new Set(socialTabs.map(tab => tab.id));
  const retained = (groups || []).map(group => ({
    ...group,
    tabIds: (group.tabIds || []).filter(id => !socialIds.has(id))
  })).filter(group => group.tabIds.length > 0);

  retained.push({
    name: 'Socials',
    color: 'blue',
    tabIds: socialTabs.map(tab => tab.id)
  });
  return retained;
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

/**
 * Execute grouping for the given window (or active window)
 */
export async function executeTabGrouping(windowId, settings) {
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
  const duplicateTabsClosed = await eliminateDuplicateTabs(boundedTabs, resolvedWindowId);

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

  let effectiveSettings = settings;
  if (!effectiveSettings) {
    const [syncSettings, localSecrets] = await Promise.all([
      chrome.storage.sync.get(),
      chrome.storage.local.get([
        'geminiApiKey', 'openaiApiKey', 'openaiOAuthToken',
        'xaiApiKey', 'groqApiKey', 'openrouterApiKey',
        'deepseekApiKey', 'cerebrasApiKey', 'ollamaApiKey'
      ])
    ]);
    effectiveSettings = { ...syncSettings, ...localSecrets };
  }
  let fallbackUsed = false;
  let fallbackReason = null;
  let resultSource = 'unknown';
  let aiMeta = null;
  let qualityIssues = [];

  if (!isIncognitoWindow) await LearningCache.ensureSchema();
  const provider = effectiveSettings.provider || 'gemini_nano';
  const requestedModel = modelForSettings(effectiveSettings);
  const groupingStrategy = effectiveSettings.groupingStrategy === 'site' ? 'site' : 'task';
  const cacheScope = `${PROMPT_VERSION}:${groupingStrategy}:${provider}:${requestedModel}`;

  console.log(`[Foldnex] Starting grouping for ${groupableTabs.length} tabs in window ${resolvedWindowId}...`);

  let finalGroups = [];
  let exactCacheContext = null;

  if (groupingStrategy === 'site') {
    finalGroups = clusterTabsBySite(groupableTabs);
    resultSource = 'site-category';
    console.log(`[Foldnex] Grouped ${groupableTabs.length} tabs locally by site category.`);

    if (!isIncognitoWindow) {
      finalGroups = await LearningCache.applyGroupPreferences(finalGroups, groupableTabs);
      const { matchedGroups: explicitGroups } = await LearningCache.classifyExplicit(groupableTabs);
      finalGroups = mergeExplicitGroups(finalGroups, explicitGroups);
    }
  } else if (!isIncognitoWindow) {
    const cached = await ExactResultCache.get(groupableTabs, cacheScope);
    exactCacheContext = cached.context;
    if (cached.groups?.length) {
      finalGroups = cached.groups;
      resultSource = 'exact-cache';
      console.log(`[Foldnex] Reused an exact semantic result for ${groupableTabs.length} unchanged tabs.`);
    }
  }

  if (finalGroups.length === 0) {
    if (provider === 'offline') {
      console.log('[Foldnex] Using Offline Smart Clusterer (Zero AI mode selected)');
      finalGroups = clusterTabsOffline(groupableTabs);
      resultSource = 'offline';
    } else {
      try {
        let aiResult = await clusterTabsWithAI(groupableTabs, effectiveSettings);
        finalGroups = aiResult.groups;
        aiMeta = aiResult.meta;
        resultSource = aiMeta.provider === 'gemini_nano' ? 'nano' : 'cloud';

        const firstQuality = assessGroupingQuality(finalGroups, groupableTabs.length);
        qualityIssues = firstQuality.issues;
        if (!firstQuality.passed) {
          console.warn(`[Foldnex] Retrying one semantic quality failure: ${qualityIssues.join('; ')}`);
          try {
            const retry = await clusterTabsWithAI(groupableTabs, effectiveSettings, qualityIssues.join('; '));
            const retryQuality = assessGroupingQuality(retry.groups, groupableTabs.length);
            const firstUsage = aiMeta.usage || {};
            const retryUsage = retry.meta.usage || {};
            aiMeta = {
              ...retry.meta,
              latencyMs: Number(aiMeta.latencyMs || 0) + Number(retry.meta.latencyMs || 0),
              usage: {
                promptTokens: Number(firstUsage.promptTokens || 0) + Number(retryUsage.promptTokens || 0),
                completionTokens: Number(firstUsage.completionTokens || 0) + Number(retryUsage.completionTokens || 0),
                totalTokens: Number(firstUsage.totalTokens || 0) + Number(retryUsage.totalTokens || 0),
                cachedTokens: Number(firstUsage.cachedTokens || 0) + Number(retryUsage.cachedTokens || 0)
              }
            };
            finalGroups = retry.groups;
            qualityIssues = retryQuality.issues;
          } catch (retryErr) {
            console.warn('[Foldnex] Quality retry failed; preserving the valid first result:', retryErr);
            qualityIssues.push('quality_retry_failed');
          }
        }
      } catch (aiErr) {
        console.warn(`[Foldnex] AI provider failed or blocked: "${aiErr.message}". Falling back to Offline Smart Clusterer...`);
        fallbackUsed = true;
        fallbackReason = aiErr.message;
        resultSource = 'offline-fallback';
        finalGroups = clusterTabsOffline(groupableTabs);
      }
    }

    if (groupingStrategy === 'task') {
      finalGroups = enforceSocialGroup(finalGroups, groupableTabs);
    }

    if (!isIncognitoWindow) {
      finalGroups = await LearningCache.applyGroupPreferences(finalGroups, groupableTabs);
      const { matchedGroups: explicitGroups } = await LearningCache.classifyExplicit(groupableTabs);
      finalGroups = mergeExplicitGroups(finalGroups, explicitGroups);
    }

    // Site-category mode deliberately permits large same-site groups (for
    // example all Envato pages), so semantic breadth checks only apply to the
    // title-aware strategy.
    if (groupingStrategy === 'task') {
      const appliedQuality = assessGroupingQuality(finalGroups, groupableTabs.length);
      qualityIssues = [...new Set([
        ...qualityIssues,
        ...appliedQuality.issues
      ])];
    }

    if (!isIncognitoWindow && !fallbackUsed && groupingStrategy === 'task') {
      exactCacheContext ||= await ExactResultCache.makeContext(groupableTabs, cacheScope);
      await ExactResultCache.put(exactCacheContext, finalGroups);
    }
  }

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
      // background worker, including when grouping runs from the Nano popup.
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

  // Record privacy-safe diagnostics. Raw titles, URLs, prompts, and provider
  // response bodies are intentionally excluded.
  if (!isIncognitoWindow) {
    const now = Date.now();
    const usage = aiMeta?.usage || {};
    await recordRun({
      timestamp: now,
      groupsCreated: groupsCreatedCount,
      tabsGrouped: groupableTabs.length,
      duplicateTabsClosed,
      strategy: groupingStrategy,
      provider,
      model: groupingStrategy === 'task' ? aiMeta?.model || requestedModel : null,
      source: resultSource,
      promptVersion: PROMPT_VERSION,
      promptTokens: Number(usage.promptTokens || 0),
      completionTokens: Number(usage.completionTokens || 0),
      cachedTokens: Number(usage.cachedTokens || 0),
      latencyMs: Math.round(performance.now() - runStartedAt),
      providerLatencyMs: Number(aiMeta?.latencyMs || 0),
      qualityFlags: qualityIssues,
      fallbackCode: fallbackUsed
        ? (/429|quota/i.test(fallbackReason || '') ? 'quota' : /401|key/i.test(fallbackReason || '') ? 'auth' : 'provider_error')
        : null,
      fallbackDetail: fallbackUsed
        ? String(fallbackReason || 'Provider unavailable').replace(/[\r\n\t]+/g, ' ').slice(0, 180)
        : null,
      groups: finalGroups.map(group => ({ name: group.name, size: group.tabIds?.length || 0 }))
    });
  }

  return {
    success: true,
    fallbackUsed,
    fallbackReason,
    message: groupingStrategy === 'site'
      ? `Organized ${groupableTabs.length} tabs into ${groupsCreatedCount} groups by site category.`
      : fallbackUsed
        ? `Organized ${groupableTabs.length} tabs into ${groupsCreatedCount} groups using Offline Smart Mode (AI unavailable/blocked).`
        : `Successfully organized ${groupableTabs.length} tabs into ${groupsCreatedCount} groups!`,
    groupsCreated: groupsCreatedCount,
    totalTabs: groupableTabs.length,
    duplicateTabsClosed,
    strategy: groupingStrategy,
    source: resultSource,
    model: groupingStrategy === 'task' ? aiMeta?.model || requestedModel : null,
    qualityFlags: qualityIssues,
    groups: finalGroups
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
    const groupedTabIds = tabs.filter(t => t.groupId && t.groupId !== -1).map(t => t.id);

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
