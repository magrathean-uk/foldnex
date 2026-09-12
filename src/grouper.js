/**
 * Foldnex - Group Orchestrator
 * Connects tab querying, local learning cache, AI clustering, and native Chrome tabGroups API.
 */

import { LearningCache } from './cache-engine.js';
import { clusterTabsWithAI, CHROME_GROUP_COLORS } from './ai-engine.js';
import { clusterTabsOffline } from './offline-clusterer.js';

// In-memory registry of active group titles managed by Foldnex to prevent feedback loops
export const knownGroupTitles = new Map(); // groupId -> title

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
  const groupableTabs = getGroupableTabs(boundedTabs);

  if (groupableTabs.length <= 1) {
    return {
      success: true,
      message: 'Not enough tabs to group (minimum 2 unpinned tabs required)',
      groupsCreated: 0,
      totalTabs: groupableTabs.length
    };
  }

  const effectiveSettings = settings || (await chrome.storage.sync.get());
  let fallbackUsed = false;
  let fallbackReason = null;

  console.log(`[Foldnex] Starting grouping for ${groupableTabs.length} tabs in window ${resolvedWindowId}...`);

  // Step 1: Instant Local Cache Matching (0ms fast path)
  const { matchedGroups, unmatched } = await LearningCache.classifyLocal(groupableTabs);
  console.log(`[Foldnex] Local cache matched ${matchedGroups.length} groups, ${unmatched.length} unmatched tabs.`);

  let finalGroups = [];

  // If local cache categorized all tabs, we complete immediately with 0 network calls!
  if (unmatched.length === 0 && matchedGroups.length > 0) {
    finalGroups = matchedGroups.map(g => ({
      name: g.name,
      color: g.color || 'blue',
      tabIds: g.tabs.map(t => t.id)
    }));
  } else {
    let aiTabsToCluster = groupableTabs;

    // Check if user explicitly chose Offline Smart Mode (Zero-AI)
    if (effectiveSettings.provider === 'offline') {
      console.log('[Foldnex] Using Offline Smart Clusterer (Zero AI mode selected)');
      finalGroups = clusterTabsOffline(aiTabsToCluster);
    } else {
      try {
        finalGroups = await clusterTabsWithAI(aiTabsToCluster, effectiveSettings);
      } catch (aiErr) {
        console.warn(`[Foldnex] AI provider failed or blocked: "${aiErr.message}". Falling back to Offline Smart Clusterer...`);
        fallbackUsed = true;
        fallbackReason = aiErr.message;
        finalGroups = clusterTabsOffline(aiTabsToCluster);
      }
    }

    // Step 2: Feed back into Learning Engine ONLY if NOT Incognito to protect privacy
    if (!isIncognitoWindow) {
      const tabMap = new Map(groupableTabs.map(t => [t.id, t]));
      const groupsWithTabs = finalGroups.map(g => ({
        name: g.name,
        color: g.color,
        tabs: g.tabIds.map(id => tabMap.get(id)).filter(Boolean)
      }));
      await LearningCache.learnFromGroupings(groupsWithTabs);
    } else {
      console.log('[Foldnex] Incognito window detected: skipping persistent learning to protect privacy.');
    }
  }

  // Step 3: Tab strip ordering & anti-thrashing
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

      // Register title before API update so onUpdated ignores this programmatic event
      knownGroupTitles.set(groupId, grp.name);

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
          knownGroupTitles.set(groupId, grp.name);
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

  // Record stats
  if (!isIncognitoWindow) {
    const now = Date.now();
    await chrome.storage.local.set({
      foldnex_last_run: {
        timestamp: now,
        groupsCreated: groupsCreatedCount,
        tabsGrouped: groupableTabs.length
      }
    });
  }

  return {
    success: true,
    fallbackUsed,
    fallbackReason,
    message: fallbackUsed
      ? `Organized ${groupableTabs.length} tabs into ${groupsCreatedCount} groups using Offline Smart Mode (AI unavailable/blocked).`
      : `Successfully organized ${groupableTabs.length} tabs into ${groupsCreatedCount} groups!`,
    groupsCreated: groupsCreatedCount,
    totalTabs: groupableTabs.length,
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
