/**
 * Foldnex - Background Service Worker (Manifest V3)
 * Handles toolbar clicks, keyboard shortcuts, background grouping, and continuous learning.
 */

import { applyPlanOffer, cancelPlanWork, executeTabGrouping, getPlanOffer, ungroupAllTabs } from './src/grouper.js';
import { LearningCache, PlanMemory, PlanOfferStore, readResetEpoch, WindowPlanStore } from './src/cache-engine.js';
import { PROVIDER_CATALOG, providerSettingKey } from './src/ai-engine.js';
import { createBackgroundClassifier } from './src/background-classifier.js';
import { loadSettings, saveEngineChoice } from './src/settings.js';
import {
  consumeProgrammaticGroupUpdate,
  getGroupTitleBaseline,
  removeGroupState,
  seedGroupTitleBaselines,
  setGroupTitleBaseline
} from './src/group-state.js';

// API keys live in storage.local and should only be readable by trusted
// extension pages and the service worker, never by a future content script.
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

// Transient runtime locks & timers
let activeBadgeTimer = null;
let isGroupingActive = false;

// Watches tab events for Auto-group's local attach. No engine labels or
// prepares anything in the background.
const backgroundClassifier = createBackgroundClassifier();
let backgroundSettingsRevision = 0;
const BACKGROUND_SETTING_KEYS = new Set([
  'autoGroupNewTabs', 'provider', 'groupingStrategy',
  'geminiModel', 'geminiReasoningEffort', 'openaiPriority',
  ...Object.keys(PROVIDER_CATALOG).flatMap(provider => ['baseUrl', 'model', 'reasoningEffort'].map(suffix => providerSettingKey(provider, suffix)))
]);
const BACKGROUND_SECRET_KEYS = new Set([
  'geminiApiKey', 'openaiOAuthToken',
  ...Object.keys(PROVIDER_CATALOG).map(provider => providerSettingKey(provider, 'apiKey'))
]);

// Tabs Chrome restores in the first seconds after startup are not new tabs.
const STARTUP_QUIET_MS = 20000;
const SESSION_STARTED_KEY = 'foldnex_session_started_v1';
let startupQuietUntil = 0;
let autoGroupSetting = null;

// Session storage is empty after a browser start (or an install, update or
// reload), so the first worker run of a session starts the quiet period even
// when restored tabs' events reach the worker before onStartup.
const workerStartedAt = Date.now();
const sessionChecked = Promise.resolve()
  .then(() => chrome.storage.session.get(SESSION_STARTED_KEY))
  .then(data => {
    if (data?.[SESSION_STARTED_KEY]) return;
    startupQuietUntil = Math.max(startupQuietUntil, workerStartedAt + STARTUP_QUIET_MS);
    return chrome.storage.session.set({ [SESSION_STARTED_KEY]: true });
  })
  .catch(() => {});

/** Whether a tab event now marks a new tab for Auto-group, which attaches it locally. */
async function autoGroupForTabEvents() {
  await sessionChecked;
  autoGroupSetting ??= chrome.storage.sync.get('autoGroupNewTabs')
    .then(data => Boolean(data.autoGroupNewTabs))
    .catch(() => false);
  return (await autoGroupSetting) && Date.now() >= startupQuietUntil;
}

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

function tellPopup(message) {
  try {
    Promise.resolve(chrome.runtime.sendMessage?.(message)).catch(() => {});
  } catch {
    // No popup is listening.
  }
}

/** Tell an open popup that a late plan is waiting for a window (it re-reads it through GET_PLAN_OFFER). */
function announcePlanOffer(windowId) {
  tellPopup({ type: 'PLAN_OFFER_READY', windowId });
}

/** Tell an open popup that a late plan will not be offered after all. */
function announcePlanFailed(windowId) {
  tellPopup({ type: 'PLAN_OFFER_FAILED', windowId });
}

// A chrome.tabs.group call an Auto-group attach already issued cannot be
// cancelled. Cleanup, Apply and Ungroup wait this long for it to settle before
// changing membership, then proceed (D34): they set membership themselves.
const ATTACH_SETTLE_MS = 2000;

/** Pause Auto-group and let any attach already in flight settle (bounded). */
async function pauseAndSettleAttaches() {
  backgroundClassifier.pause();
  let timer = null;
  try {
    await Promise.race([
      backgroundClassifier.whenIdle(),
      new Promise(resolve => { timer = setTimeout(resolve, ATTACH_SETTLE_MS); })
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  let result = null;
  try {
    // Cancel any Auto-group attach in flight so it cannot move a tab mid-cleanup.
    await pauseAndSettleAttaches();
    setBadgeLoading();
    result = await executeTabGrouping(windowId, null, { onPlanOffer: announcePlanOffer, onPlanFailed: announcePlanFailed });
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
    backgroundClassifier.resume();
  }
}

/**
 * Ungroup a window with the background paused, so an auto-group already
 * running cannot regroup it, and stop treating its tabs as new. It takes the
 * same lock as cleanup and Apply, so none of them interleave.
 */
async function ungroupWindow(windowId) {
  if (isGroupingActive) throw new Error('Grouping already in progress');
  isGroupingActive = true;
  try {
    await pauseAndSettleAttaches();
    const result = await ungroupAllTabs(windowId);
    await backgroundClassifier.noteWindowUngrouped(windowId);
    return result;
  } finally {
    isGroupingActive = false;
    backgroundClassifier.resume();
  }
}

/**
 * Auto-group, the engine or a credential changed. No engine works in the
 * background, so an attach in flight under the old settings is dropped.
 */
async function backgroundOptInChanged(revision) {
  if (revision !== backgroundSettingsRevision) return;
  await backgroundClassifier.clear();
}

/** Candidate keys of the stored plan group covering at least half of these tabs. */
async function planKeysForTabs(windowId, tabIds) {
  const plan = await WindowPlanStore.get(windowId);
  const ids = new Set(tabIds);
  let best = null;
  for (const group of plan?.groups || []) {
    const overlap = (group.tabIds || []).filter(id => ids.has(id)).length;
    if (overlap > 0 && overlap >= 0.5 * ids.size && (!best || overlap > best.overlap)) {
      best = { keys: group.keys || [], overlap };
    }
  }
  return best?.keys || [];
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
      const res = await ungroupWindow(currentTab?.windowId);
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
  const epoch = await readResetEpoch();
  // TabGroup does not reliably identify private windows. Resolve the member
  // tabs before touching shared title state or learning anything from a name.
  let tabsInGroup;
  try {
    tabsInGroup = await chrome.tabs.query({ groupId: group.id });
  } catch {
    return;
  }
  if (group.incognito || tabsInGroup.length === 0 || tabsInGroup.some(tab => tab.incognito)) return;

  if (await consumeProgrammaticGroupUpdate(group)) {
    return;
  }

  const previousTitle = await getGroupTitleBaseline(group.id);
  if (previousTitle === undefined) {
    // A service-worker restart must not reinterpret an existing title as a
    // user action. Establish the baseline and wait for a later change.
    await setGroupTitleBaseline(group.id, group.title);
    return;
  }
  if (previousTitle === group.title) return;
  await setGroupTitleBaseline(group.id, group.title);

  try {
    const validTabs = tabsInGroup.filter(tab => tab.url && !tab.incognito);
    if (validTabs.length > 0) {
      await LearningCache.learnGroupRename(validTabs, group.title, group.color, { epoch });
      // Also remember it by tab fingerprints, so the name follows the group
      // when tabs are added or removed.
      const keys = await planKeysForTabs(group.windowId, validTabs.map(tab => tab.id));
      await PlanMemory.recordUserRename({ tabs: validTabs, name: group.title, color: group.color, keys }, { epoch });
      console.log(`[Foldnex] Learned a scoped rename for ${validTabs.length} tabs.`);
    }
  } catch (err) {
    console.warn('[Foldnex] Error learning group update:', err);
  }
});

// Clean up memory registry when a tab group is closed
chrome.tabGroups.onRemoved.addListener((group) => {
  removeGroupState(group.id).catch(err => {
    console.warn('[Foldnex] Failed to clear removed group state:', err);
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  // A late plan for a closed window is dropped, never stored or announced.
  cancelPlanWork(windowId);
  WindowPlanStore.remove(windowId).catch(err => {
    console.warn('[Foldnex] Failed to clear a closed window plan:', err);
  });
  PlanOfferStore.remove(windowId).catch(err => {
    console.warn('[Foldnex] Failed to clear a closed window plan offer:', err);
  });
});

/**
 * Manage dynamic popup behavior:
 * If user turns ON "Direct 1-Click Mode", clicking the icon triggers grouping directly.
 * If user turns OFF "Direct 1-Click Mode", clicking the icon opens popup.html.
 */
async function syncPopupBehavior(explicitMode) {
  const data = await chrome.storage.sync.get(['oneClickIconMode', 'setupChoice']);
  const isOneClick = typeof explicitMode === 'boolean' ? explicitMode : Boolean(data.oneClickIconMode);
  // Run from toolbar skips the popup, so it waits until the setup card is answered.
  if (isOneClick && data.setupChoice) {
    await chrome.action.setPopup({ popup: '' }); // enables chrome.action.onClicked
  } else {
    await chrome.action.setPopup({ popup: 'popup.html' });
  }
}

// Top-level listener for storage changes (handles options page toggles, popup toggles, and cross-device sync)
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && 'oneClickIconMode' in changes) {
    syncPopupBehavior(Boolean(changes.oneClickIconMode.newValue));
  } else if (areaName === 'sync' && 'setupChoice' in changes) {
    syncPopupBehavior();
  }
  if (areaName === 'sync' && 'autoGroupNewTabs' in changes) {
    const enabled = Boolean(changes.autoGroupNewTabs.newValue);
    autoGroupSetting = Promise.resolve(enabled);
    backgroundClassifier.setAutoGroup(enabled).catch(err => {
      console.warn('[Foldnex] Could not reset new-tab tracking:', err?.message);
    });
  }
  const backgroundChanged = (areaName === 'sync' && Object.keys(changes).some(key => BACKGROUND_SETTING_KEYS.has(key) || BACKGROUND_SECRET_KEYS.has(key)))
    || (areaName === 'local' && Object.keys(changes).some(key => BACKGROUND_SECRET_KEYS.has(key) || key === 'foldnex_reset_epoch'));
  if (backgroundChanged) {
    // Abort before any asynchronous settings read. Allowed-to-allowed engine
    // and endpoint changes must not carry an older tab admission into a request.
    backgroundClassifier.invalidate();
    const revision = ++backgroundSettingsRevision;
    backgroundOptInChanged(revision).catch(err => {
      console.warn('[Foldnex] Could not apply the background setting:', err?.message);
    });
  }
});

// Initialize on install or startup
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Foldnex] Installed / Updated:', details.reason);
  // Under the settings lock: a choice saved meanwhile is never overwritten.
  await saveEngineChoice({
    provider: 'offline',
    groupingStrategy: 'task',
    oneClickIconMode: false,
    collapseGroupsOnCreation: false
  }, { ifUnset: true });
  // An update moves a saved Gemini Nano engine to Offline smart mode and
  // removes the retired label cache now, before any surface opens (both
  // live in loadSettings).
  await loadSettings().catch(err => {
    console.warn('[Foldnex] Could not migrate saved settings:', err?.message);
  });
  await LearningCache.ensureSchema();
  // The per-tab assignment cache of development builds never shipped.
  await chrome.storage.local.remove('foldnex_tab_assignments_v1');
  await syncPopupBehavior();
});

chrome.runtime.onStartup.addListener(async () => {
  startupQuietUntil = Date.now() + STARTUP_QUIET_MS;
  await LearningCache.ensureSchema();
  await seedGroupTitleBaselines(await chrome.tabGroups.query({}));
  await syncPopupBehavior();
});

chrome.tabs.onCreated?.addListener(async (tab) => {
  if (tab?.incognito) return;
  const revision = backgroundSettingsRevision;
  try {
    const autoGroup = await autoGroupForTabEvents();
    if (revision !== backgroundSettingsRevision) return;
    await backgroundClassifier.noteTabCreated(tab, { autoGroup });
  } catch (err) {
    console.warn('[Foldnex] Could not track a new tab:', err?.message);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tab?.incognito) return;
  const revision = backgroundSettingsRevision;
  try {
    const autoGroup = await autoGroupForTabEvents();
    if (revision !== backgroundSettingsRevision) return;
    await backgroundClassifier.noteTabUpdated(tabId, changeInfo, tab, { autoGroup });
  } catch (err) {
    console.warn('[Foldnex] Could not track a tab update:', err?.message);
  }
});

chrome.tabs.onRemoved?.addListener((tabId) => {
  backgroundClassifier.noteTabRemoved(tabId).catch(err => {
    console.warn('[Foldnex] Could not forget a closed tab:', err?.message);
  });
});

// Clear any stale badges on service worker evaluation
chrome.action.setBadgeText({ text: '' });
syncPopupBehavior();
LearningCache.ensureSchema().catch(err => {
  console.warn('[Foldnex] Could not migrate learning storage:', err);
});
chrome.tabGroups.query({}).then(seedGroupTitleBaselines).catch(err => {
  console.warn('[Foldnex] Could not seed group title baselines:', err);
});

/**
 * Messaging API for Popup & Options Pages
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TRIGGER_GROUPING') {
    (async () => {
      try {
        let targetWindowId = message.windowId;
        if (!targetWindowId) {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          targetWindowId = tab?.windowId;
        }
        const result = await triggerOneClickGrouping(targetWindowId);
        // A refused run (one already in progress) is an error for the popup,
        // not a result with no group count.
        if (result?.success === false) sendResponse({ success: false, error: result.error || result.message || 'Grouping failed' });
        else sendResponse({ success: true, result });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep message channel open for async response
  }

  if (message.type === 'GET_PLAN_OFFER') {
    (async () => {
      try {
        const offer = Number.isInteger(message.windowId) ? await getPlanOffer(message.windowId, { verify: true }) : null;
        sendResponse({ ok: true, offer });
      } catch (err) {
        sendResponse({ ok: false, offer: null, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === 'APPLY_PLAN_OFFER') {
    (async () => {
      if (!Number.isInteger(message.windowId)) {
        sendResponse({ success: true, result: { success: false, reason: 'none' } });
        return;
      }
      if (isGroupingActive) {
        sendResponse({ success: false, error: 'Grouping already in progress' });
        return;
      }
      isGroupingActive = true;
      try {
        await pauseAndSettleAttaches();
        const result = await applyPlanOffer(message.windowId);
        if (result.success) setBadgeSuccess(result.groupsCreated);
        sendResponse({ success: true, result });
      } catch (err) {
        setBadgeError();
        sendResponse({ success: false, error: err.message });
      } finally {
        isGroupingActive = false;
        backgroundClassifier.resume();
      }
    })();
    return true;
  }

  if (message.type === 'UNGROUP_ALL') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const result = await ungroupWindow(tab?.windowId);
        sendResponse({ success: true, result });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
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
