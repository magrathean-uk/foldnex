/**
 * Foldnex - Popup Interface Controller
 */

import { LearningCache } from './src/cache-engine.js';
import { executeTabGrouping } from './src/grouper.js';
import {
  checkChromeNanoStatus,
  PROVIDER_CATALOG,
  getEffectiveReasoningEffort,
  getReasoningEffortOptions,
  isOpenAIResponsesOnlyModel,
  providerSettingKey
} from './src/ai-engine.js';

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
const strategyInputs = document.querySelectorAll('input[name="groupingStrategy"]');
const providerSelect = document.getElementById('providerSelect');
const modelReasoningSummary = document.getElementById('modelReasoningSummary');
const tabShortcut = document.getElementById('tabShortcut');
const nanoHint = document.getElementById('nanoHint');
const statRulesCount = document.getElementById('statRulesCount');
const statLastGrouped = document.getElementById('statLastGrouped');
const toggleOneClickMode = document.getElementById('toggleOneClickMode');
const providerPreferenceKeys = Object.entries(PROVIDER_CATALOG).flatMap(([id, config]) => {
  if (id === 'gemini_api') return ['geminiModel', 'geminiReasoningEffort'];
  if (config.mode === 'compatible') return [providerSettingKey(id, 'model'), providerSettingKey(id, 'reasoningEffort')];
  return [];
});

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
function renderProviderSelect() {
  providerSelect.textContent = '';
  Object.entries(PROVIDER_CATALOG).forEach(([id, provider]) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = provider.mode === 'local' || provider.local
      ? `${provider.name} · local`
      : provider.name;
    providerSelect.append(option);
  });
}

async function refreshEngineStatus() {
  const localKeyNames = Object.keys(PROVIDER_CATALOG)
    .filter(id => PROVIDER_CATALOG[id].mode === 'compatible')
    .map(id => providerSettingKey(id, 'apiKey'));
  const secretNames = ['geminiApiKey', 'openaiOAuthToken', ...localKeyNames];
  const [syncSettings, localSettings] = await Promise.all([
    chrome.storage.sync.get(['provider', 'groupingStrategy', ...secretNames, ...providerPreferenceKeys]),
    chrome.storage.local.get(secretNames)
  ]);
  const secrets = { ...syncSettings, ...localSettings };

  const provider = syncSettings.provider || 'gemini_nano';
  const groupingStrategy = syncSettings.groupingStrategy === 'site' ? 'site' : 'task';
  const config = PROVIDER_CATALOG[provider] || PROVIDER_CATALOG.gemini_nano;
  strategyInputs.forEach(input => { input.checked = input.value === groupingStrategy; });
  providerSelect.value = provider;
  providerSelect.disabled = groupingStrategy === 'site';
  modelReasoningSummary.classList.add('hidden');

  if (groupingStrategy === 'site') {
    nanoHint.classList.remove('hidden');
    nanoHint.textContent = 'Groups locally by address. X, Reddit, and Slack become Socials; ChatGPT and Grok become AI.';
    engineBadge.className = 'badge ready';
    engineBadge.textContent = 'Local · no AI';
    return;
  }

  nanoHint.textContent = 'Runs locally in Chrome. No tab data leaves this device.';

  if (provider === 'gemini_api' || config.mode === 'compatible') {
    const model = provider === 'gemini_api'
      ? syncSettings.geminiModel || config.defaultModel
      : syncSettings[providerSettingKey(provider, 'model')] || config.defaultModel;
    const savedEffort = provider === 'gemini_api'
      ? syncSettings.geminiReasoningEffort
      : syncSettings[providerSettingKey(provider, 'reasoningEffort')];
    const effort = getEffectiveReasoningEffort(provider, model, savedEffort);
    const adjustable = getReasoningEffortOptions(provider, model).length > 0;
    const effortLabel = provider === 'openai' && isOpenAIResponsesOnlyModel(model)
      ? 'Unavailable in Foldnex'
      : effort
        ? `${effort[0].toUpperCase()}${effort.slice(1)}${adjustable ? '' : ' (fixed)'}`
        : 'Provider default';
    modelReasoningSummary.textContent = `${model} · Reasoning: ${effortLabel}`;
    modelReasoningSummary.classList.remove('hidden');
  } else if (provider === 'gemini_nano') {
    modelReasoningSummary.textContent = 'Reasoning: Managed by Chrome';
    modelReasoningSummary.classList.remove('hidden');
  }

  const hasGeminiKey = Boolean(secrets.geminiApiKey);

  if (provider === 'gemini_nano') {
    nanoHint.classList.remove('hidden');
    const nanoStatus = await checkChromeNanoStatus();
    if (nanoStatus.status === 'ready') {
      engineBadge.className = 'badge ready';
      engineBadge.textContent = 'Nano ready';
    } else if (nanoStatus.status === 'downloadable' || nanoStatus.status === 'downloading') {
      engineBadge.className = 'badge warning';
      engineBadge.textContent = 'Downloading';
    } else {
      engineBadge.className = 'badge danger';
      engineBadge.textContent = 'Setup needed';
    }
  } else if (provider === 'gemini_api') {
    nanoHint.classList.remove('hidden');
    nanoHint.textContent = 'Cloud mode sends complete tab titles and host/path hints to Google Gemini when you group.';
    if (hasGeminiKey) {
      engineBadge.className = 'badge ready';
      engineBadge.textContent = 'Gemini ready';
    } else {
      engineBadge.className = 'badge danger';
      engineBadge.textContent = 'Key missing';
    }
  } else if (config.mode === 'compatible') {
    nanoHint.classList.remove('hidden');
    nanoHint.textContent = config.local
      ? 'Runs through the Ollama server on this device. No tab data is sent to a cloud provider.'
      : `Cloud mode sends complete tab titles and host/path hints to ${config.name} when you group.`;
    const apiKey = secrets[providerSettingKey(provider, 'apiKey')];
    const hasAuth = Boolean(apiKey || (provider === 'openai' && secrets.openaiOAuthToken));
    if (provider === 'openai' && isOpenAIResponsesOnlyModel(syncSettings.openaiModel || config.defaultModel)) {
      engineBadge.className = 'badge danger';
      engineBadge.textContent = 'Model unavailable';
      nanoHint.textContent = 'Choose an OpenAI Chat Completions model in settings.';
    } else if (hasAuth || config.keyOptional) {
      engineBadge.className = 'badge ready';
      engineBadge.textContent = `${config.name} ready`;
    } else {
      engineBadge.className = 'badge danger';
      engineBadge.textContent = 'Key missing';
    }
  } else if (provider === 'offline') {
    nanoHint.classList.add('hidden');
    engineBadge.className = 'badge ready';
    engineBadge.textContent = 'Local';
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
      const { timestamp, groupsCreated, source, model } = localData.foldnex_last_run;
      const minsAgo = Math.round((Date.now() - timestamp) / 60000);
      statLastGrouped.textContent = minsAgo <= 1 ? 'Just now' : `${minsAgo}m ago (${groupsCreated} grps)`;
      statLastGrouped.title = `${source || 'unknown'}${model ? ` · ${model}` : ''}`;
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
  try {
    const [[activeTab], { provider = 'gemini_nano', groupingStrategy = 'task' }] = await Promise.all([
      chrome.tabs.query({ active: true, lastFocusedWindow: true }),
      chrome.storage.sync.get(['provider', 'groupingStrategy'])
    ]);

    // Nano must execute in an extension document. Cloud and offline engines run
    // through the background worker so one context owns orchestration and locks.
    let res;
    if (groupingStrategy !== 'site' && provider === 'gemini_nano') {
      res = await executeTabGrouping(activeTab?.windowId);
    } else {
      const response = await chrome.runtime.sendMessage({
        type: 'TRIGGER_GROUPING',
        windowId: activeTab?.windowId
      });
      if (!response?.success) throw new Error(response?.error || 'Grouping failed');
      res = response.result;
    }
    const duplicates = res.duplicateTabsClosed || 0;
    const duplicateSummary = duplicates === 1
      ? ' Removed 1 duplicate tab.'
      : duplicates > 1
        ? ` Removed ${duplicates} duplicate tabs.`
        : '';

    if (res.groupsCreated === 0) {
      if (duplicates > 0) {
        showStatus(`Cleanup complete.${duplicateSummary}`, 'success');
      } else {
        showStatus(res.message || 'Need at least 2 unpinned tabs to create groups.', 'warning');
      }
      setTimeout(hideStatus, 3500);
      return;
    }

    if (res.fallbackUsed) {
      let reasonSnippet = 'AI unavailable';
      if (res.fallbackCode === 'quota') {
        reasonSnippet = 'AI quota exceeded';
      } else if (res.fallbackCode === 'auth') {
        reasonSnippet = 'Invalid API key';
      } else if (res.fallbackCode === 'timeout') {
        reasonSnippet = 'AI timed out';
      } else if (res.fallbackCode === 'nano_unavailable') {
        reasonSnippet = 'local model unavailable';
      }
      showStatus(`Created ${res.groupsCreated} groups offline (${reasonSnippet}).${duplicateSummary}`, 'warning');
    } else if (res.qualityFlags?.length) {
      showStatus(`Created ${res.groupsCreated} groups; review recommended.${duplicateSummary}`, 'warning');
    } else {
      showStatus(`Created ${res.groupsCreated} groups.${duplicateSummary}`, 'success');
    }

    refreshTabCount();
    refreshStats();
    setTimeout(hideStatus, 3500);
  } catch (error) {
    showStatus(error.message || 'Grouping failed. Check options.', 'error');
  }
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
strategyInputs.forEach(input => input.addEventListener('change', async () => {
  if (!input.checked) return;
  await chrome.storage.sync.set({ groupingStrategy: input.value });
  await refreshEngineStatus();
}));

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
    if (changes.provider || changes.groupingStrategy || providerPreferenceKeys.some(key => changes[key])) {
      refreshEngineStatus();
    }
    if (changes.oneClickIconMode !== undefined) {
      toggleOneClickMode.checked = Boolean(changes.oneClickIconMode.newValue);
    }
  }
  if (areaName === 'local') {
    if (Object.keys(changes).some(key => key === 'geminiApiKey' || key === 'openaiOAuthToken' || key.endsWith('ApiKey'))) {
      refreshEngineStatus();
    }
    if (changes[LearningCache.STORAGE_KEY] || changes.foldnex_last_run) {
      refreshStats();
    }
  }
});

// Initial boot
document.addEventListener('DOMContentLoaded', async () => {
  renderProviderSelect();
  chrome.commands.getAll().then(commands => {
    const shortcut = commands.find(command => command.name === 'group-tabs')?.shortcut;
    if (!shortcut) return;
    tabShortcut.textContent = shortcut.replace('Command+Shift+', '⌘⇧');
    tabShortcut.title = shortcut;
    tabShortcut.classList.remove('hidden');
  }).catch(() => {});
  await Promise.all([
    refreshTabCount(),
    refreshEngineStatus(),
    refreshStats()
  ]);
});
