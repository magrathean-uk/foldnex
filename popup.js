/**
 * Foldnex - Popup Interface Controller
 */

import { LearningCache } from './src/cache-engine.js';
import { checkChromeNanoStatus } from './src/ai-engine.js';

// DOM elements
const tabCountLabel = document.getElementById('tabCountLabel');
const btnGroupTabs = document.getElementById('btnGroupTabs');
const btnUngroup = document.getElementById('btnUngroup');
const btnOptions = document.getElementById('btnOptions');
const linkManageRules = document.getElementById('linkManageRules');
const statusBox = document.getElementById('statusBox');
const statusSpinner = document.getElementById('statusSpinner');
const statusMessage = document.getElementById('statusMessage');
const engineBadge = document.getElementById('engineBadge');
const providerSelect = document.getElementById('providerSelect');
const nanoHint = document.getElementById('nanoHint');
const statRulesCount = document.getElementById('statRulesCount');
const statLastGrouped = document.getElementById('statLastGrouped');
const toggleOneClickMode = document.getElementById('toggleOneClickMode');

/**
 * Show status box with type
 */
function showStatus(msg, type = 'loading') {
  statusBox.className = `status-box ${type}`;
  statusBox.classList.remove('hidden');
  statusMessage.textContent = msg;

  if (type === 'loading') {
    statusSpinner.classList.remove('hidden');
    btnGroupTabs.disabled = true;
  } else {
    statusSpinner.classList.add('hidden');
    btnGroupTabs.disabled = false;
  }
}

function hideStatus() {
  statusBox.classList.add('hidden');
  btnGroupTabs.disabled = false;
}

/**
 * Refresh current tab count
 */
async function refreshTabCount() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const UNGROUPABLE_PREFIXES = [
      'chrome://', 'chrome-devtools://', 'chrome-extension://',
      'about:', 'edge://', 'brave://', 'devtools://'
    ];
    const groupable = tabs.filter(t => {
      const url = t.url || t.pendingUrl || '';
      return !t.pinned && url && !UNGROUPABLE_PREFIXES.some(p => url.startsWith(p));
    });
    tabCountLabel.textContent = `${groupable.length} tabs in this window`;
  } catch (err) {
    tabCountLabel.textContent = 'Tabs ready';
  }
}

/**
 * Update active engine diagnosis badge
 */
async function refreshEngineStatus() {
  const syncSettings = await chrome.storage.sync.get(['provider', 'geminiApiKey', 'openaiApiKey', 'openaiOAuthToken']);
  const localSettings = await chrome.storage.local.get(['geminiApiKey', 'openaiApiKey', 'openaiOAuthToken']);

  const provider = syncSettings.provider || 'gemini_nano';
  providerSelect.value = provider;

  const hasGeminiKey = Boolean(localSettings.geminiApiKey || syncSettings.geminiApiKey);
  const hasOpenAIAuth = Boolean(localSettings.openaiApiKey || syncSettings.openaiApiKey || localSettings.openaiOAuthToken || syncSettings.openaiOAuthToken);

  if (provider === 'gemini_nano') {
    nanoHint.classList.remove('hidden');
    const nanoStatus = await checkChromeNanoStatus();
    if (nanoStatus.status === 'ready') {
      engineBadge.className = 'badge ready';
      engineBadge.textContent = 'Nano Ready (Local)';
    } else if (nanoStatus.status === 'downloadable' || nanoStatus.status === 'downloading') {
      engineBadge.className = 'badge warning';
      engineBadge.textContent = 'Downloading Model';
    } else {
      engineBadge.className = 'badge danger';
      engineBadge.textContent = 'Setup Needed';
    }
  } else if (provider === 'gemini_api') {
    nanoHint.classList.add('hidden');
    if (hasGeminiKey) {
      engineBadge.className = 'badge ready';
      engineBadge.textContent = 'Gemini 2.0 Flash';
    } else {
      engineBadge.className = 'badge danger';
      engineBadge.textContent = 'Key Missing';
    }
  } else if (provider === 'openai') {
    nanoHint.classList.add('hidden');
    if (hasOpenAIAuth) {
      engineBadge.className = 'badge ready';
      engineBadge.textContent = 'OpenAI Ready';
    } else {
      engineBadge.className = 'badge danger';
      engineBadge.textContent = 'Auth Missing';
    }
  } else if (provider === 'offline') {
    nanoHint.classList.add('hidden');
    engineBadge.className = 'badge ready';
    engineBadge.textContent = 'Zero AI (100% Local)';
  }
}

/**
 * Load statistics & learning cache metrics
 */
async function refreshStats() {
  try {
    const rules = await LearningCache.getRules();
    statRulesCount.textContent = rules.length.toString();

    const localData = await chrome.storage.local.get('foldnex_last_run');
    if (localData.foldnex_last_run) {
      const { timestamp, groupsCreated } = localData.foldnex_last_run;
      const minsAgo = Math.round((Date.now() - timestamp) / 60000);
      statLastGrouped.textContent = minsAgo <= 1 ? 'Just now' : `${minsAgo}m ago (${groupsCreated} grps)`;
    } else {
      statLastGrouped.textContent = 'Never';
    }

    const { oneClickIconMode } = await chrome.storage.sync.get('oneClickIconMode');
    toggleOneClickMode.checked = Boolean(oneClickIconMode);
  } catch (err) {
    console.warn('[Foldnex] Error loading stats:', err);
  }
}

// Event: Group tabs with actionable fallback diagnostics
btnGroupTabs.addEventListener('click', async () => {
  showStatus('Analyzing tabs & organizing...', 'loading');
  chrome.runtime.sendMessage({ type: 'TRIGGER_GROUPING' }, (response) => {
    if (chrome.runtime.lastError) {
      showStatus(`Error: ${chrome.runtime.lastError.message}`, 'error');
      return;
    }

    if (response?.success) {
      const res = response.result;
      if (res.groupsCreated === 0) {
        showStatus(res.message || 'Need at least 2 unpinned tabs to create groups.', 'warning');
        setTimeout(hideStatus, 3500);
        return;
      }

      if (res.fallbackUsed) {
        let reasonSnippet = 'AI unavailable';
        if (res.fallbackReason?.includes('429') || res.fallbackReason?.toLowerCase().includes('quota')) {
          reasonSnippet = 'AI quota exceeded';
        } else if (res.fallbackReason?.includes('401') || res.fallbackReason?.toLowerCase().includes('key')) {
          reasonSnippet = 'Invalid API key';
        }
        showStatus(`Grouped ${res.groupsCreated} groups via Offline Mode (${reasonSnippet}).`, 'warning');
      } else {
        showStatus(`Organized into ${res.groupsCreated} smart groups!`, 'success');
      }

      refreshTabCount();
      refreshStats();
      setTimeout(hideStatus, 3500);
    } else {
      showStatus(response?.error || 'Grouping failed. Check options.', 'error');
    }
  });
});

// Event: Ungroup
btnUngroup.addEventListener('click', async () => {
  showStatus('Ungrouping tabs...', 'loading');
  chrome.runtime.sendMessage({ type: 'UNGROUP_ALL' }, (response) => {
    if (response?.success) {
      showStatus('All tabs ungrouped', 'success');
      refreshTabCount();
      setTimeout(hideStatus, 2000);
    } else {
      showStatus(response?.error || 'Failed to ungroup tabs', 'error');
    }
  });
});

// Event: Provider changed
providerSelect.addEventListener('change', async (e) => {
  const newProvider = e.target.value;
  await chrome.storage.sync.set({ provider: newProvider });
  await refreshEngineStatus();
});

// Event: Toggle Direct 1-Click Toolbar Mode
toggleOneClickMode.addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  await chrome.storage.sync.set({ oneClickIconMode: enabled });
  chrome.runtime.sendMessage({ type: 'SYNC_POPUP_MODE' });
});

// Event: Settings & Rules links
btnOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
linkManageRules.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// Reactive Storage Synchronization across windows/popups
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync') {
    if (changes.provider || changes.geminiApiKey || changes.openaiApiKey || changes.openaiOAuthToken) {
      refreshEngineStatus();
    }
    if (changes.oneClickIconMode !== undefined) {
      toggleOneClickMode.checked = Boolean(changes.oneClickIconMode.newValue);
    }
  }
  if (areaName === 'local') {
    if (changes.geminiApiKey || changes.openaiApiKey || changes.openaiOAuthToken) {
      refreshEngineStatus();
    }
    if (changes[LearningCache.STORAGE_KEY] || changes.foldnex_last_run) {
      refreshStats();
    }
  }
});

// Initial boot
document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([
    refreshTabCount(),
    refreshEngineStatus(),
    refreshStats()
  ]);
});
