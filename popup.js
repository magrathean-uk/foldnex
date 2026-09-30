/**
 * Foldnex - Popup Interface Controller
 */

import { LearningCache } from './src/cache-engine.js';
import {
  checkChromeNanoStatus,
  PROVIDER_CATALOG,
  getEffectiveReasoningEffort,
  getReasoningEffortOptions,
  isOpenAIResponsesOnlyModel,
  providerSettingKey
} from './src/ai-engine.js';
import { isOnDeviceEngine } from './src/background-classifier.js';
import { loadSettings } from './src/settings.js';

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
const setupCard = document.getElementById('setupCard');
const setupChoices = setupCard.querySelectorAll('.setup-choice');
const setupNanoChoice = document.getElementById('setupNanoChoice');
const setupNanoStatus = document.getElementById('setupNanoStatus');
const setupNanoDetail = document.getElementById('setupNanoDetail');
const setupKeepChoice = document.getElementById('setupKeepChoice');
const setupKeepCopy = document.getElementById('setupKeepCopy');
const providerPreferenceKeys = Object.entries(PROVIDER_CATALOG).flatMap(([id, config]) => {
  if (id === 'gemini_api') return ['geminiModel', 'geminiReasoningEffort'];
  if (config.mode === 'compatible') return [providerSettingKey(id, 'model'), providerSettingKey(id, 'reasoningEffort'), providerSettingKey(id, 'baseUrl')];
  return [];
});
const OLLAMA_BASE_URL_KEY = providerSettingKey('ollama', 'baseUrl');
// Settings that decide whether tabs may be labelled in the background.
const BACKGROUND_SCOPE_KEYS = ['provider', 'groupingStrategy', 'backgroundPrep', 'autoGroupNewTabs', OLLAMA_BASE_URL_KEY];
// Engines that send tab data to a provider: Gemini and compatible APIs except Ollama.
const CLOUD_PROVIDERS = Object.keys(PROVIDER_CATALOG).filter(id => {
  const config = PROVIDER_CATALOG[id];
  return (config.mode === 'gemini' || config.mode === 'compatible') && !config.local;
});
const NANO_UNLOAD_COPY = Object.freeze({
  immediately: 'releases it right after use',
  '2m': 'releases it after 2 minutes idle',
  '5m': 'releases it after 5 minutes idle',
  '15m': 'releases it after 15 minutes idle',
  '60m': 'releases it after 1 hour idle',
  never: 'keeps it loaded'
});
let statusHideTimer = null;
let setupNanoCheck = null;
let setupBusy = false;
let latestPopupRun = null;
let engineStatusRevision = 0;

/**
 * Show status box with type
 */
function showStatus(msg, type = 'loading') {
  clearTimeout(statusHideTimer);
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

// A later status cancels the pending hide, so it cannot clear a running cleanup.
function hideStatusAfter(ms) {
  clearTimeout(statusHideTimer);
  statusHideTimer = setTimeout(hideStatus, ms);
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
    tabCountLabel.textContent = `${groupable.length} ${groupable.length === 1 ? 'tab' : 'tabs'} in this window`;
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

// A saved credential means configured, not authenticated. Only show a past
// failure for the selected provider/model; never echo provider error bodies.
function renderConfiguredProvider(config, lastRun, provider, model) {
  engineBadge.className = 'badge';
  engineBadge.textContent = `${provider === 'gemini_api' ? 'Gemini' : config.name} configured`;
  nanoHint.textContent += ' Connection not verified.';
  if (lastRun?.provider !== provider || lastRun.strategy !== 'task' || lastRun.model !== model) return;
  const failures = {
    auth: ['danger', 'Last run: auth failed', 'Last cleanup ran offline because authentication failed. Check the API key in Settings and try again.'],
    quota: ['warning', 'Last run: quota', 'Last cleanup ran offline because the provider reported a quota or rate limit. Check your provider account before retrying.'],
    timeout: ['warning', 'Last run: timed out', 'Last cleanup ran offline because the provider timed out. Try again or choose another engine.'],
    provider_error: ['danger', 'Last run: failed', 'Last cleanup ran offline because the provider request failed. Check the connection in Settings.']
  };
  const failure = failures[lastRun.fallbackCode];
  if (!failure) return;
  engineBadge.className = `badge ${failure[0]}`;
  engineBadge.textContent = failure[1];
  nanoHint.textContent += ` ${failure[2]}`;
}

async function refreshEngineStatus() {
  const revision = ++engineStatusRevision;
  const [syncSettings, runData] = await Promise.all([
    loadSettings(),
    chrome.storage.local.get('foldnex_last_run').catch(() => ({}))
  ]);
  if (revision !== engineStatusRevision) return;
  const secrets = syncSettings;
  const lastRun = latestPopupRun || runData.foldnex_last_run;

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
    if (revision !== engineStatusRevision) return;
    if (nanoStatus.status === 'ready') {
      engineBadge.className = 'badge ready';
      engineBadge.textContent = 'Nano available';
      nanoHint.textContent += ' If the model needs loading, cleanup can use temporary local groups while it warms. Run cleanup again to use the prepared labels.';
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
      renderConfiguredProvider(config, lastRun, provider, syncSettings.geminiModel || config.defaultModel);
    } else {
      engineBadge.className = 'badge danger';
      engineBadge.textContent = 'Key missing';
    }
  } else if (config.mode === 'compatible') {
    nanoHint.classList.remove('hidden');
    nanoHint.textContent = isOnDeviceEngine(syncSettings)
      ? 'Runs through the Ollama server on this device. No tab data is sent to a cloud provider.'
      : `Cloud mode sends complete tab titles and host/path hints to ${config.name} when you group.`;
    const apiKey = secrets[providerSettingKey(provider, 'apiKey')];
    const hasAuth = Boolean(apiKey || (provider === 'openai' && secrets.openaiOAuthToken));
    if (provider === 'openai' && isOpenAIResponsesOnlyModel(syncSettings.openaiModel || config.defaultModel)) {
      engineBadge.className = 'badge danger';
      engineBadge.textContent = 'Model unavailable';
      nanoHint.textContent = 'Choose an OpenAI Chat Completions model in settings.';
    } else if (hasAuth || config.keyOptional) {
      renderConfiguredProvider(config, lastRun, provider, syncSettings[providerSettingKey(provider, 'model')] || config.defaultModel);
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

/** Setup choice that matches a saved engine: cloud, nano, offline, or keep (Ollama). */
function setupChoiceFor(provider) {
  if (provider === 'gemini_nano') return 'nano';
  if (provider === 'offline') return 'offline';
  if (provider === 'ollama') return 'keep';
  return CLOUD_PROVIDERS.includes(provider) ? 'cloud' : null;
}

function apiKeyStorageKey(provider) {
  return provider === 'gemini_api' ? 'geminiApiKey' : providerSettingKey(provider, 'apiKey');
}

/**
 * Show the first-run card until a choice is saved. An engine already saved
 * by an earlier version is marked Current.
 */
async function refreshSetupCard() {
  const settings = await chrome.storage.sync.get(['setupChoice', 'provider', 'modelUnloadAfter', OLLAMA_BASE_URL_KEY]);
  if (settings.setupChoice) {
    setupCard.classList.add('hidden');
    return;
  }
  const current = settings.provider ? setupChoiceFor(settings.provider) : null;
  setupChoices.forEach(choice => {
    if (choice === setupKeepChoice) return;
    const isCurrent = choice.dataset.choice === current;
    if (isCurrent) choice.setAttribute('aria-current', 'true');
    else choice.removeAttribute('aria-current');
    choice.querySelector('.setup-pill.current')?.classList.toggle('hidden', !isCurrent);
  });
  setupKeepChoice.classList.toggle('hidden', current !== 'keep');
  // Ollama at another address is not on this device: say where titles go.
  setupKeepCopy.textContent = current !== 'keep' || isOnDeviceEngine(settings)
    ? 'Runs through the Ollama server on this device.'
    : 'Runs through your Ollama server at another address. Page titles and a short site hint are sent to it when you group.';
  const unload = NANO_UNLOAD_COPY[settings.modelUnloadAfter] || NANO_UNLOAD_COPY['5m'];
  setupNanoDetail.textContent = `Uses about 3 GB of memory while the model is loaded and ${unload} (change in Settings). The first load takes 15-25 seconds.`;
  setupCard.classList.remove('hidden');
  refreshSetupNanoAvailability();
}

/** Same Prompt API check as Settings; an unavailable model disables the choice with its reason. */
async function refreshSetupNanoAvailability() {
  setupNanoCheck ??= checkChromeNanoStatus();
  const status = await setupNanoCheck;
  const unavailable = status.status === 'unavailable';
  if (unavailable) setupNanoChoice.setAttribute('aria-disabled', 'true');
  else setupNanoChoice.removeAttribute('aria-disabled');
  if (unavailable) {
    setupNanoStatus.textContent = `Not available: ${String(status.detail || 'Prompt API unavailable')}.`;
  } else if (status.status === 'downloadable' || status.status === 'downloading') {
    setupNanoStatus.textContent = 'Chrome needs a one-time model download first. Settings opens to start it.';
  } else {
    setupNanoStatus.textContent = '';
  }
  setupNanoStatus.classList.toggle('hidden', !setupNanoStatus.textContent);
}

/** Open Settings at the engine section, reusing an open Settings tab. */
async function openEngineSettings() {
  const url = chrome.runtime.getURL('options/options.html#engine');
  try {
    const [existing] = await chrome.tabs.query({ url: chrome.runtime.getURL('options/options.html') });
    if (existing?.id !== undefined) {
      await chrome.tabs.update(existing.id, { url, active: true });
      await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
      return;
    }
  } catch {
    // Fall through to a new tab.
  }
  await chrome.tabs.create({ url });
}

function finishSetup(message) {
  setupCard.classList.add('hidden');
  // Never replace the progress of a cleanup that is still running.
  if (!btnGroupTabs.disabled) {
    showStatus(message, 'success');
    hideStatusAfter(3500);
  }
  btnGroupTabs.focus({ preventScroll: true });
}

/**
 * Cloud: reuse a key already saved for the current or another cloud engine
 * (presence only; the value is never shown). Without one, keep the engine
 * unchanged and open Settings so the user can add a key.
 */
async function chooseCloudSetup() {
  const secrets = await loadSettings();
  const { provider } = secrets;
  const hasKey = id => Boolean(secrets[apiKeyStorageKey(id)] || (id === 'openai' && secrets.openaiOAuthToken));
  const keyed = [provider, 'openai', ...CLOUD_PROVIDERS]
    .find(id => CLOUD_PROVIDERS.includes(id) && hasKey(id));
  if (keyed) {
    await chrome.storage.sync.set({ provider: keyed, setupChoice: 'cloud' });
    finishSetup(`${PROVIDER_CATALOG[keyed].name} selected with your saved key.`);
    return;
  }
  await chrome.storage.sync.set({ setupChoice: 'cloud' });
  finishSetup('Add an API key in Settings to finish.');
  await openEngineSettings();
}

async function chooseSetup(choice) {
  if (choice === 'cloud') {
    await chooseCloudSetup();
  } else if (choice === 'nano') {
    setupNanoCheck ??= checkChromeNanoStatus();
    const status = await setupNanoCheck;
    if (status.status === 'unavailable') return;
    await chrome.storage.sync.set({ provider: 'gemini_nano', backgroundPrep: true, setupChoice: 'nano' });
    if (status.status === 'downloadable' || status.status === 'downloading') {
      finishSetup('Gemini Nano selected. Start its download in Settings.');
      await openEngineSettings();
    } else {
      finishSetup('Gemini Nano selected. Its first load takes 15-25 seconds.');
    }
  } else if (choice === 'offline') {
    await chrome.storage.sync.set({ provider: 'offline', setupChoice: 'offline' });
    finishSetup('Offline mode selected. Tabs are grouped on this computer.');
  } else if (choice === 'keep') {
    const settings = await chrome.storage.sync.get(['provider', OLLAMA_BASE_URL_KEY]);
    await chrome.storage.sync.set({ setupChoice: isOnDeviceEngine(settings) ? 'nano' : 'cloud' });
    finishSetup('Keeping Ollama.');
  }
}

setupChoices.forEach(choice => choice.addEventListener('click', async () => {
  if (setupBusy || choice.getAttribute('aria-disabled') === 'true') return;
  setupBusy = true;
  try {
    await chooseSetup(choice.dataset.choice);
  } catch (error) {
    showStatus('Could not save this choice. Try again or open Settings.', 'error');
  } finally {
    setupBusy = false;
  }
}));

const REVIEW_CODES = new Set(['generic', 'regional', 'too_many']);

/**
 * Whether saved settings let the worker label tabs in the background: an
 * on-device engine with Prepare in background or Auto-group on, or a cloud
 * engine with Auto-group on. By site category and Offline never label.
 */
function backgroundLabellingAllowed(settings = {}) {
  if (settings.groupingStrategy === 'site') return false;
  const provider = settings.provider || 'gemini_nano';
  if (provider === 'offline' || !PROVIDER_CATALOG[provider]) return false;
  // On-device engines finish a cleanup's leftover tabs even without background preparation.
  if (isOnDeviceEngine(settings)) return true;
  return Boolean(settings.autoGroupNewTabs);
}

/**
 * Extra status sentences: tabs placed by address, and a model still loading.
 * The background promise needs both the worker's `provisionalInBackground`
 * and settings that allow background labelling; otherwise the popup points
 * to the next cleanup.
 */
function resultNotes(res, inBackground = false) {
  let notes = '';
  const provisional = Number(res.provisionalTabs) || 0;
  if (provisional > 0) {
    const placed = provisional === 1 ? '1 tab placed by address' : `${provisional} tabs placed by address`;
    if (res.incognito) {
      notes += ` ${placed}.`;
    } else {
      notes += inBackground
        ? ` ${placed}; background labelling prepares a later cleanup.`
        : ` ${placed}; run another cleanup to try labelling ${provisional === 1 ? 'it' : 'them'} again.`;
    }
  }
  if (res.fallbackCode === 'nano_loading') notes += ' The on-device model is still loading.';
  return notes;
}

// Event: Group tabs with actionable fallback diagnostics
btnGroupTabs.addEventListener('click', async () => {
  showStatus('Analyzing tabs & organizing...', 'loading');
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

    // Every engine, Nano included, runs in the background worker. It owns the
    // grouping lock and pauses background classification so the click gets
    // the model immediately.
    const response = await chrome.runtime.sendMessage({
      type: 'TRIGGER_GROUPING',
      windowId: activeTab?.windowId
    });
    if (!response?.success) throw new Error(response?.error || 'Grouping failed');
    const res = response.result;
    if (res.provider) latestPopupRun = res;
    await refreshEngineStatus();
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
      hideStatusAfter(3500);
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
    } else {
      const inBackground = Boolean(res.provisionalInBackground)
        && backgroundLabellingAllowed(await chrome.storage.sync.get(BACKGROUND_SCOPE_KEYS).catch(() => ({})));
      const notes = resultNotes(res, inBackground);
      // 'oversized' alone is a diagnostic, not something to review.
      const review = (res.qualityCodes || []).some(code => REVIEW_CODES.has(code));
      showStatus(
        `Created ${res.groupsCreated} groups${review ? '; review recommended' : ''}.${duplicateSummary}${notes}`,
        review ? 'warning' : 'success'
      );
    }

    refreshTabCount();
    refreshStats();
    hideStatusAfter(res.provisionalTabs > 0 ? 6000 : 3500);
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
      hideStatusAfter(2000);
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
    if (changes.setupChoice || changes.provider || changes.modelUnloadAfter || changes[OLLAMA_BASE_URL_KEY]) {
      refreshSetupCard().catch(() => {});
    }
    if (changes.oneClickIconMode !== undefined) {
      toggleOneClickMode.checked = Boolean(changes.oneClickIconMode.newValue);
    }
  }
  if (areaName === 'local') {
    if (changes.foldnex_last_run) latestPopupRun = null;
    if (changes.foldnex_last_run || Object.keys(changes).some(key => key === 'geminiApiKey' || key === 'openaiOAuthToken' || key.endsWith('ApiKey'))) {
      refreshEngineStatus();
    }
    if (changes[LearningCache.STORAGE_KEY] || changes.foldnex_last_run) {
      refreshStats();
    }
  }
});

// Initial boot
document.addEventListener('DOMContentLoaded', async () => {
  // Warm the on-device model and label this window's tabs first while the
  // user reads the popup. Nothing is sent to a cloud engine.
  chrome.tabs.query({ active: true, lastFocusedWindow: true })
    .then(([activeTab]) => chrome.runtime.sendMessage({ type: 'PREPARE_GROUPING', windowId: activeTab?.windowId }))
    .catch(() => {});
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
    refreshStats(),
    refreshSetupCard().catch(err => console.warn('[Foldnex] Setup choice unavailable:', err))
  ]);
});
