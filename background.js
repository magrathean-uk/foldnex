/**
 * Foldnex - Background Service Worker (Manifest V3)
 * Handles toolbar clicks, keyboard shortcuts, background grouping, and continuous learning.
 */

import { executeTabGrouping, ungroupAllTabs } from './src/grouper.js';
import { LearningCache, PlanMemory, WindowPlanStore } from './src/cache-engine.js';
import {
  checkChromeNanoStatus,
  configureOnDeviceMemory,
  getOnDeviceModelState,
  releaseOnDeviceModel,
  runNanoSpike,
  warmChromeNano
} from './src/ai-engine.js';
import { createBackgroundClassifier, dumpWindowLabels, loadBackgroundScope } from './src/background-classifier.js';
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

// Classify tabs as they finish loading so a cleanup only applies remembered groups.
const backgroundClassifier = createBackgroundClassifier();

// How long an idle on-device model stays loaded (modelUnloadAfter, '5m' when
// unset): Nano's sessions here, loopback Ollama through keep_alive.
const memoryPolicyReady = chrome.storage.sync.get('modelUnloadAfter')
  .then(data => { configureOnDeviceMemory({ unloadAfter: data?.modelUnloadAfter }); })
  .catch(() => {});

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

/** Whether a tab event now marks a new tab for Auto-group (and cloud consent). */
async function autoGroupForTabEvents() {
  await sessionChecked;
  autoGroupSetting ??= chrome.storage.sync.get('autoGroupNewTabs')
    .then(data => Boolean(data.autoGroupNewTabs))
    .catch(() => false);
  return (await autoGroupSetting) && Date.now() >= startupQuietUntil;
}

/** What the background may do now, or null when the settings cannot be read. */
async function readBackgroundScope() {
  try {
    return await loadBackgroundScope();
  } catch {
    return null;
  }
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

/**
 * Core execution trigger with badge animation and re-entrancy mutex
 */
async function triggerOneClickGrouping(windowId) {
  if (isGroupingActive) {
    console.warn('[Foldnex] Grouping already in progress. Ignoring duplicate trigger.');
    return { success: false, error: 'Grouping already in progress' };
  }

  isGroupingActive = true;
  // Abort any in-flight background prompt so the click gets the model.
  backgroundClassifier.pause();
  let result = null;
  let backgroundScope = null;
  try {
    setBadgeLoading();
    result = await executeTabGrouping(windowId);
    if (result?.provisionalTabs > 0) {
      // Provisional tabs are labelled in the background only by an on-device
      // engine the user lets prepare (or Auto-group); otherwise the next click labels them.
      backgroundScope = await readBackgroundScope();
      result.provisionalInBackground = Boolean(backgroundScope?.onDevice && (backgroundScope.allowed || backgroundScope.cleanupFollowUp));
    }
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
    // Tabs placed by address at the deadline get their model labels in the
    // background when it may run, under the classifier's own consent gates.
    if (backgroundScope?.allowed) {
      backgroundClassifier.enqueue(result?.provisionalTabIds || [], { retryGivenUp: true });
    } else if (backgroundScope?.cleanupFollowUp) {
      backgroundClassifier.enqueue(result?.provisionalTabIds || [], { reason: 'cleanup', retryGivenUp: true });
    }
    if (result?.strategy === 'task' && !result.incognito && Number.isInteger(result.windowId)) {
      backgroundClassifier.scheduleWindowPlanRefresh(result.windowId);
    }
  }
}

/**
 * Ungroup a window with the background paused, so an auto-group already
 * running cannot regroup it, and stop treating its tabs as new.
 */
async function ungroupWindow(windowId) {
  backgroundClassifier.pause();
  let timer = null;
  try {
    await Promise.race([
      backgroundClassifier.whenIdle(),
      new Promise(resolve => { timer = setTimeout(resolve, 1000); })
    ]);
    clearTimeout(timer);
    const result = await ungroupAllTabs(windowId);
    await backgroundClassifier.noteWindowUngrouped(windowId);
    return result;
  } finally {
    backgroundClassifier.resume();
  }
}

/**
 * Load the on-device model while nobody is waiting (a cold load takes 15-25 s),
 * so a later cleanup finds it warm. Only for Nano in By task mode. Opening the
 * popup warms it because a cleanup usually follows; a browser or worker start
 * (`background`) only when background preparation or Auto-group is on. Never
 * with the 'immediately' unload setting, which would let go of a warm model
 * 6 s after it loads. The warm counts as a use, so the idle unload covers it.
 */
async function maybeWarmNano({ background = false } = {}) {
  try {
    await memoryPolicyReady;
    if (getOnDeviceModelState().unloadAfter === 'immediately') return;
    const { provider = 'gemini_nano', groupingStrategy = 'task', setupChoice } = await chrome.storage.sync.get(['provider', 'groupingStrategy', 'setupChoice']);
    // Nothing loads the 3 GB model before the user has answered the setup card.
    if (!setupChoice || provider !== 'gemini_nano' || groupingStrategy === 'site') return;
    if (background && !(await readBackgroundScope())?.allowed) return;
    if ((await checkChromeNanoStatus()).status === 'ready') await warmChromeNano();
  } catch (err) {
    console.warn('[Foldnex] Could not warm the on-device model:', err?.message);
  }
}

/**
 * Let go of Foldnex's Gemini Nano sessions now. Background work stops first,
 * so a running batch cannot load the model straight back; it returns to the
 * queue and continues under the current settings.
 * @returns {Promise<boolean>} whether any session was released
 */
async function releaseNanoSessions() {
  backgroundClassifier.pause();
  let timer = null;
  try {
    await Promise.race([
      backgroundClassifier.whenIdle(),
      new Promise(resolve => { timer = setTimeout(resolve, 1000); })
    ]);
    return releaseOnDeviceModel();
  } finally {
    clearTimeout(timer);
    backgroundClassifier.resume();
  }
}

/**
 * Background preparation, Auto-group or the engine changed. When background
 * work is no longer allowed, stop it and drop the queue; when preparation or
 * Auto-group was just turned on for an on-device engine, queue every open tab
 * once, as after an install.
 */
async function backgroundOptInChanged(changes) {
  const scope = await loadBackgroundScope();
  if (!scope.allowed) {
    await backgroundClassifier.clear();
    return;
  }
  const turnedOn = key => Boolean(changes[key]?.newValue) && !changes[key]?.oldValue;
  if (scope.onDevice && (turnedOn('backgroundPrep') || turnedOn('autoGroupNewTabs'))) await queueOpenTabs();
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
    const tabsInGroup = await chrome.tabs.query({ groupId: group.id });
    const validTabs = tabsInGroup.filter(tab => tab.url && !tab.incognito);
    if (validTabs.length > 0) {
      await LearningCache.learnGroupRename(validTabs, group.title, group.color);
      // Also remember it by tab fingerprints, so the name follows the group
      // when tabs are added or removed.
      const keys = await planKeysForTabs(group.windowId, validTabs.map(tab => tab.id));
      await PlanMemory.recordUserRename({ tabs: validTabs, name: group.title, color: group.color, keys });
      console.log(`[Foldnex] Learned scoped rename "${group.title}" for ${validTabs.length} tabs.`);
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
  WindowPlanStore.remove(windowId).catch(err => {
    console.warn('[Foldnex] Failed to clear a closed window plan:', err);
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
  if (areaName === 'sync' && 'modelUnloadAfter' in changes) {
    // After the startup read, so an older stored value cannot win.
    memoryPolicyReady.then(() => configureOnDeviceMemory({ unloadAfter: changes.modelUnloadAfter.newValue }));
  }
  if (areaName === 'sync' && 'provider' in changes) {
    // Another engine never uses Nano's sessions: let go of the model now.
    const from = changes.provider.oldValue || 'gemini_nano';
    const to = changes.provider.newValue || 'gemini_nano';
    if (to !== 'gemini_nano' && (from === 'gemini_nano' || getOnDeviceModelState().loaded)) {
      releaseNanoSessions().catch(err => {
        console.warn('[Foldnex] Could not release the on-device model:', err?.message);
      });
    }
  }
  if (areaName === 'sync' && ['backgroundPrep', 'autoGroupNewTabs', 'provider', 'groupingStrategy'].some(key => key in changes)) {
    backgroundOptInChanged(changes).catch(err => {
      console.warn('[Foldnex] Could not apply the background setting:', err?.message);
    });
  }
});

// Initialize on install or startup
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Foldnex] Installed / Updated:', details.reason);
  const current = await chrome.storage.sync.get();
  if (!current.provider) {
    await chrome.storage.sync.set({
      provider: 'gemini_nano',
      groupingStrategy: 'task',
      oneClickIconMode: false,
      collapseGroupsOnCreation: false
    });
  }
  await LearningCache.ensureSchema();
  // The per-tab assignment cache of development builds never shipped.
  await chrome.storage.local.remove('foldnex_tab_assignments_v1');
  await syncPopupBehavior();
  await queueOpenTabs();
  maybeWarmNano({ background: true });
});

chrome.runtime.onStartup.addListener(async () => {
  startupQuietUntil = Date.now() + STARTUP_QUIET_MS;
  await LearningCache.ensureSchema();
  await seedGroupTitleBaselines(await chrome.tabGroups.query({}));
  await syncPopupBehavior();
  await queueOpenTabs();
  maybeWarmNano({ background: true });
});

/**
 * Queue every open tab for an on-device engine, when background preparation
 * or Auto-group allows it. Tabs already open never go to a cloud engine.
 */
async function queueOpenTabs() {
  try {
    const scope = await loadBackgroundScope();
    if (!scope.allowed || !scope.onDevice) return;
    const tabs = await chrome.tabs.query({});
    backgroundClassifier.enqueue(tabs.filter(tab => !tab.incognito).map(tab => tab.id));
  } catch (err) {
    console.warn('[Foldnex] Could not queue open tabs:', err?.message);
  }
}

chrome.tabs.onCreated?.addListener(async (tab) => {
  if (tab?.incognito) return;
  try {
    await backgroundClassifier.noteTabCreated(tab, { autoGroup: await autoGroupForTabEvents() });
  } catch (err) {
    console.warn('[Foldnex] Could not track a new tab:', err?.message);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tab?.incognito) return;
  try {
    await backgroundClassifier.noteTabUpdated(tabId, changeInfo, tab, { autoGroup: await autoGroupForTabEvents() });
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
maybeWarmNano({ background: true });

// Unpacked development installs only: measurement helpers for the console.
// Nothing here is stored.
Promise.resolve(chrome.management?.getSelf?.()).then(self => {
  if (self?.installType !== 'development') return;
  globalThis.foldnexNanoSpike = runNanoSpike;
  globalThis.foldnexLabelDump = dumpWindowLabels;
}).catch(() => {});

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
        const result = await ungroupWindow(tab?.windowId);
        sendResponse({ success: true, result });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === 'PREPARE_GROUPING') {
    (async () => {
      maybeWarmNano();
      try {
        // Opening the popup never sends a window's tabs to a cloud engine.
        const scope = await loadBackgroundScope();
        if (scope.allowed && scope.onDevice && Number.isInteger(message.windowId)) {
          await backgroundClassifier.prioritize(message.windowId);
        }
      } catch (err) {
        console.warn('[Foldnex] Could not prepare grouping:', err?.message);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'UNLOAD_ON_DEVICE_MODEL') {
    (async () => {
      let released = false;
      try {
        if (getOnDeviceModelState().loaded) released = await releaseNanoSessions();
      } catch (err) {
        console.warn('[Foldnex] Could not release the on-device model:', err?.message);
      }
      sendResponse({ ok: true, released });
    })();
    return true;
  }

  if (message.type === 'GET_ON_DEVICE_MODEL_STATE') {
    (async () => {
      await memoryPolicyReady;
      sendResponse({ ok: true, ...getOnDeviceModelState() });
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
