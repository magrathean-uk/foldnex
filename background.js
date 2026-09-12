/**
 * Foldnex - Background Service Worker (Manifest V3)
 * Handles toolbar clicks, keyboard shortcuts, background grouping, and continuous learning.
 */

import { executeTabGrouping, ungroupAllTabs, knownGroupTitles } from './src/grouper.js';
import { LearningCache } from './src/cache-engine.js';
import { checkChromeNanoStatus } from './src/ai-engine.js';

// Transient runtime locks & timers
let activeBadgeTimer = null;
let isGroupingActive = false;

function clearBadgeTimer() {
  if (activeBadgeTimer) {
    clearTimeout(activeBadgeTimer);
    activeBadgeTimer = null;
  }
}

// Visual badge feedback helpers
function setBadgeLoading() {
  clearBadgeTimer();
  chrome.action.setBadgeText({ text: '...' });
  chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
}

function setBadgeSuccess(count) {
  clearBadgeTimer();
  chrome.action.setBadgeText({ text: count > 0 ? `${count}` : '✓' });
  chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
  activeBadgeTimer = setTimeout(() => {
    chrome.action.setBadgeText({ text: '' });
    activeBadgeTimer = null;
  }, 2200);
}

function setBadgeError() {
  clearBadgeTimer();
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  activeBadgeTimer = setTimeout(() => {
    chrome.action.setBadgeText({ text: '' });
    activeBadgeTimer = null;
  }, 3500);
}

/**
 * Core execution trigger with badge animation and re-entrancy mutex
 */
async function triggerOneClickGrouping(windowId) {
  if (isGroupingActive) {
    console.warn('[Foldnex] Grouping already in progress. Ignoring duplicate trigger.');
    return { success: false, error: 'Grouping already in progress' };
  }

  isGroupingActive = true;
  try {
    setBadgeLoading();
    const result = await executeTabGrouping(windowId);
    if (result.success) {
      setBadgeSuccess(result.groupsCreated);
    } else {
      setBadgeError();
    }
    return result;
  } catch (err) {
    console.error('[Foldnex] Grouping failed:', err);
    setBadgeError();

    // If key/model missing, open options page for friendly user onboarding
    if (err.message.includes('not configured') || err.message.includes('API key') || err.message.includes('unsupported')) {
      chrome.runtime.openOptionsPage();
    }
    throw err;
  } finally {
    isGroupingActive = false;
  }
}

// Expose helper on global scope for debugging and testing
globalThis.triggerOneClickGrouping = triggerOneClickGrouping;
globalThis.ungroupAllTabs = ungroupAllTabs;

/**
 * Handle Toolbar Icon Click
 * Fires when user clicks extension icon (when 1-click mode is enabled)
 */
chrome.action.onClicked.addListener(async (tab) => {
  console.log('[Foldnex] Toolbar icon clicked! Starting 1-click grouping...');
  await triggerOneClickGrouping(tab.windowId);
});

/**
 * Handle Keyboard Shortcut (e.g. Alt+G / Cmd+Shift+G)
 */
chrome.commands.onCommand.addListener(async (command) => {
  console.log('[Foldnex] Shortcut received:', command);
  if (command === 'group-tabs') {
    const [currentTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await triggerOneClickGrouping(currentTab?.windowId);
  } else if (command === 'ungroup-tabs') {
    try {
      const [currentTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const res = await ungroupAllTabs(currentTab?.windowId);
      setBadgeSuccess(res.ungroupedCount);
    } catch (err) {
      console.error('[Foldnex] Ungroup shortcut failed:', err);
      setBadgeError();
    }
  }
});

/**
 * Adaptive Learning: Detect User Renaming Tab Groups
 * Differentiates Foldnex programmatic updates from human user corrections,
 * batches storage writes, and strictly respects Incognito privacy.
 */
chrome.tabGroups.onUpdated.addListener(async (group) => {
  if (!group.title) return;

  // Differentiate programmatic Foldnex updates vs. user manual rename
  const previousTitle = knownGroupTitles.get(group.id);
  if (previousTitle === group.title) {
    // Title is unchanged (event triggered by color change, collapse/expand, or Foldnex grouper)
    return;
  }

  // Update registry with the new user title
  knownGroupTitles.set(group.id, group.title);

  try {
    const tabsInGroup = await chrome.tabs.query({ groupId: group.id });
    // Filter out incognito tabs to prevent privacy leaks
    const validUrls = tabsInGroup.filter(t => t.url && !t.incognito).map(t => t.url);
    if (validUrls.length > 0) {
      // Single batch storage operation instead of per-tab loop
      await LearningCache.learnUserCorrections(validUrls, group.title, group.color);
      console.log(`[Foldnex] Learned user renamed group "${group.title}" for ${validUrls.length} tabs.`);
    }
  } catch (err) {
    console.warn('[Foldnex] Error learning group update:', err);
  }
});

// Clean up memory registry when a tab group is closed
chrome.tabGroups.onRemoved.addListener((group) => {
  knownGroupTitles.delete(group.id);
});

/**
 * Manage dynamic popup behavior:
 * If user turns ON "Direct 1-Click Mode", clicking the icon triggers grouping directly.
 * If user turns OFF "Direct 1-Click Mode", clicking the icon opens popup.html.
 */
async function syncPopupBehavior(explicitMode) {
  let isOneClick = explicitMode;
  if (typeof isOneClick !== 'boolean') {
    const data = await chrome.storage.sync.get('oneClickIconMode');
    isOneClick = Boolean(data.oneClickIconMode);
  }
  if (isOneClick) {
    await chrome.action.setPopup({ popup: '' }); // enables chrome.action.onClicked
  } else {
    await chrome.action.setPopup({ popup: 'popup.html' });
  }
}

// Top-level listener for storage changes (handles options page toggles, popup toggles, and cross-device sync)
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && 'oneClickIconMode' in changes) {
    syncPopupBehavior(Boolean(changes.oneClickIconMode.newValue));
  }
});

// Initialize on install or startup
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Foldnex] Installed / Updated:', details.reason);
  const current = await chrome.storage.sync.get();
  if (!current.provider) {
    await chrome.storage.sync.set({
      provider: 'gemini_nano',
      geminiModel: 'gemini-2.0-flash',
      openaiModel: 'gpt-4o-mini',
      oneClickIconMode: false,
      collapseGroupsOnCreation: false
    });
  }
  await syncPopupBehavior();
});

chrome.runtime.onStartup.addListener(async () => {
  await syncPopupBehavior();
});

// Clear any stale badges on service worker evaluation
chrome.action.setBadgeText({ text: '' });
syncPopupBehavior();

/**
 * Messaging API for Popup & Options Pages
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TRIGGER_GROUPING') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const result = await triggerOneClickGrouping(tab?.windowId);
        sendResponse({ success: true, result });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep message channel open for async response
  }

  if (message.type === 'UNGROUP_ALL') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const result = await ungroupAllTabs(tab?.windowId);
        sendResponse({ success: true, result });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === 'CHECK_NANO_STATUS') {
    (async () => {
      const status = await checkChromeNanoStatus();
      sendResponse(status);
    })();
    return true;
  }

  if (message.type === 'SYNC_POPUP_MODE') {
    (async () => {
      await syncPopupBehavior();
      sendResponse({ success: true });
    })();
    return true;
  }
});
