/**
 * Foldnex - Popup Interface Controller
 */

import { LearningCache } from './src/cache-engine.js';
import {
  ANTHROPIC_HOST,
  CLOUD_PROVIDER_MODES,
  PROVIDER_CATALOG,
  getEffectiveReasoningEffort,
  getReasoningEffortOptions,
  hasProviderHostAccess,
  isOpenAIResponsesOnlyModel,
  requestProviderHostAccess,
  planReasoningEffort,
  isLoopbackUrl,
  providerSettingKey,
  resolveProvider,
  resolveProviderEndpoint
} from './src/ai-engine.js';
import { isLocalOllama } from './src/background-classifier.js';
import { loadSettings, saveEngineChoice } from './src/settings.js';

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
const engineHint = document.getElementById('engineHint');
const statRulesCount = document.getElementById('statRulesCount');
const statLastGrouped = document.getElementById('statLastGrouped');
const toggleOneClickMode = document.getElementById('toggleOneClickMode');
const setupCard = document.getElementById('setupCard');
const setupChoices = setupCard.querySelectorAll('.setup-choice');
const setupKeepChoice = document.getElementById('setupKeepChoice');
const setupKeepCopy = document.getElementById('setupKeepCopy');
const planOffer = document.getElementById('planOffer');
const btnApplyPlan = document.getElementById('btnApplyPlan');
const providerPreferenceKeys = Object.entries(PROVIDER_CATALOG).flatMap(([id, config]) => {
  if (id === 'gemini_api') return ['geminiModel', 'geminiReasoningEffort'];
  if (config.mode === 'compatible') return [providerSettingKey(id, 'model'), providerSettingKey(id, 'reasoningEffort'), providerSettingKey(id, 'baseUrl')];
  if (config.mode === 'anthropic') return [providerSettingKey(id, 'model'), providerSettingKey(id, 'reasoningEffort')];
  return [];
});
const OLLAMA_BASE_URL_KEY = providerSettingKey('ollama', 'baseUrl');
// Engines that send tab data to a provider: Gemini, Anthropic and compatible APIs except Ollama.
const CLOUD_PROVIDERS = Object.keys(PROVIDER_CATALOG).filter(id => {
  const config = PROVIDER_CATALOG[id];
  return CLOUD_PROVIDER_MODES.includes(config.mode) && !config.local;
});

const HOST_ACCESS_HINT = `Allow access to ${ANTHROPIC_HOST} in Settings. Until then cleanups run locally and nothing is sent.`;
let statusHideTimer = null;
let setupBusy = false;
let latestPopupRun = null;
let engineStatusRevision = 0;
// The window this popup acts on, once known; late plans are offered for it.
// A private window's popup never looks for one.
let popupWindowId = null;
let popupIncognito = false;
// Set while the status promises a late plan, until it is offered or fails.
let planPendingWindowId = null;
// While a cleanup runs, a late-plan event for its window waits for the
// cleanup's response, which then settles from the verified offer lookup.
let cleanupRunning = false;
let planEventDuringCleanup = false;

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

function showPlanOffer(visible) {
  planOffer.classList.toggle('hidden', !visible);
  btnApplyPlan.disabled = false;
}

/** Ask the background whether a verified late plan is waiting for this window; true when shown. */
async function refreshPlanOffer(windowId) {
  if (!Number.isInteger(windowId) || popupIncognito) return false;
  const response = await chrome.runtime.sendMessage({ type: 'GET_PLAN_OFFER', windowId }).catch(() => null);
  if (windowId !== popupWindowId || popupIncognito) return false;
  showPlanOffer(Boolean(response?.offer));
  return Boolean(response?.offer);
}

/**
 * A late plan for this window was announced or failed: the verified lookup
 * decides what shows. A status promising the plan is replaced either way.
 */
async function settlePlan(windowId) {
  const offered = await refreshPlanOffer(windowId);
  if (planPendingWindowId !== windowId) return;
  planPendingWindowId = null;
  if (offered) showStatus('The late grouping is ready below.', 'success');
  else showStatus('The late grouping did not come through; the local grouping stays.', 'warning');
  hideStatusAfter(4500);
}

function noteActiveTab(activeTab) {
  if (!Number.isInteger(activeTab?.windowId)) return;
  popupWindowId = activeTab.windowId;
  popupIncognito = Boolean(activeTab.incognito);
  if (popupIncognito) showPlanOffer(false);
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
    tabCountLabel.textContent = `${groupable.length} groupable ${groupable.length === 1 ? 'tab' : 'tabs'}`;
  } catch (err) {
    tabCountLabel.textContent = 'Tabs ready';
  }
}

/**
 * The endpoint a request from this engine would really use (the resolver's
 * answer), or null when the resolver refuses the saved address.
 */
function requestEndpoint(syncSettings, provider) {
  try {
    return resolveProviderEndpoint(provider, syncSettings[providerSettingKey(provider, 'baseUrl')]);
  } catch {
    return null;
  }
}

const OLLAMA_REFUSED_HINT = 'Your saved Ollama address is not used, so cleanup runs locally with Offline smart mode and nothing is sent.';

/**
 * Update active engine diagnosis badge
 */
const PRIVATE_WINDOW_HINT = 'Private windows always use Offline smart mode: nothing is sent from them.';

function renderProviderSelect() {
  providerSelect.textContent = '';
  Object.entries(PROVIDER_CATALOG).forEach(([id, provider]) => {
    const option = document.createElement('option');
    option.value = id;
    // Ollama can be on this device or another server, so it carries no suffix.
    option.textContent = provider.mode === 'local'
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
  engineHint.textContent += ' Connection not verified.';
  if (lastRun?.provider !== provider || lastRun.strategy !== 'task' || lastRun.model !== model) return;
  const failures = {
    auth: ['danger', 'Last run: auth failed', 'Last cleanup ran offline because authentication failed. Check the API key in Settings and try again.'],
    quota: ['warning', 'Last run: quota', 'Last cleanup ran offline because the provider reported a quota or rate limit. Check your provider account before retrying.'],
    timeout: ['warning', 'Last run: timed out', 'Last cleanup ran offline because the provider timed out. Try again or choose another engine.'],
    permission: ['warning', 'Last run: access needed', 'Last cleanup ran locally because Chrome has not allowed access to this engine. Allow it in Settings.'],
    refusal: ['warning', 'Last run: declined', 'Last cleanup ran offline because the provider declined this window. Try again or choose another model.'],
    max_tokens: ['warning', 'Last run: cut off', 'Last cleanup ran offline because the answer was cut off at its output limit. Try again or choose another model.'],
    provider_error: ['danger', 'Last run: failed', 'Last cleanup ran offline because the provider request failed. Check the connection in Settings.']
  };
  const failure = failures[lastRun.fallbackCode];
  if (!failure) return;
  engineBadge.className = `badge ${failure[0]}`;
  engineBadge.textContent = failure[1];
  engineHint.textContent += ` ${failure[2]}`;
}

// The settings the status last showed: the setup click asks Chrome for host
// access from it, synchronously, before any storage read can spend the gesture.
let loadedSettings = null;

async function refreshEngineStatus() {
  const revision = ++engineStatusRevision;
  const [syncSettings, runData] = await Promise.all([
    loadSettings(),
    chrome.storage.local.get('foldnex_last_run').catch(() => ({}))
  ]);
  if (revision !== engineStatusRevision) return;
  const secrets = syncSettings;
  loadedSettings = syncSettings;
  const lastRun = latestPopupRun || runData.foldnex_last_run;

  const provider = resolveProvider(syncSettings.provider);
  const groupingStrategy = syncSettings.groupingStrategy === 'site' ? 'site' : 'task';
  const config = PROVIDER_CATALOG[provider];
  strategyInputs.forEach(input => { input.checked = input.value === groupingStrategy; });
  providerSelect.value = provider;
  providerSelect.disabled = groupingStrategy === 'site';
  modelReasoningSummary.classList.add('hidden');

  if (groupingStrategy === 'site') {
    engineHint.classList.remove('hidden');
    engineHint.textContent = 'Groups locally by address. X, Reddit and Slack start in Socials; ChatGPT and Grok in AI · Assistants.';
    engineBadge.className = 'badge ready';
    engineBadge.textContent = 'Local · no AI';
    return;
  }

  // A private window never sends anything, whatever engine is saved (D40).
  if (popupIncognito && provider !== 'offline') {
    engineHint.classList.remove('hidden');
    engineHint.textContent = PRIVATE_WINDOW_HINT;
    engineBadge.className = 'badge ready';
    engineBadge.textContent = 'Local';
    return;
  }

  if (provider === 'gemini_api' || config.mode === 'compatible' || config.mode === 'anthropic') {
    const model = provider === 'gemini_api'
      ? syncSettings.geminiModel || config.defaultModel
      : syncSettings[providerSettingKey(provider, 'model')] || config.defaultModel;
    const savedEffort = provider === 'gemini_api'
      ? syncSettings.geminiReasoningEffort
      : syncSettings[providerSettingKey(provider, 'reasoningEffort')];
    // By task, a cleanup sends one plan request at the model's lowest effort,
    // whatever is saved; show the effort it sends.
    const effort = groupingStrategy === 'task'
      ? planReasoningEffort(provider, model)
      : getEffectiveReasoningEffort(provider, model, savedEffort);
    const adjustable = groupingStrategy !== 'task' && getReasoningEffortOptions(provider, model).length > 0;
    const effortLabel = provider === 'openai' && isOpenAIResponsesOnlyModel(model)
      ? 'Unavailable in Foldnex'
      : effort
        ? `${effort[0].toUpperCase()}${effort.slice(1)}${adjustable ? '' : ' (fixed)'}`
        : 'Provider default';
    modelReasoningSummary.textContent = `${model} · Reasoning: ${effortLabel}`;
    modelReasoningSummary.classList.remove('hidden');
  }

  const hasGeminiKey = Boolean(secrets.geminiApiKey);

  if (provider === 'gemini_api') {
    engineHint.classList.remove('hidden');
    engineHint.textContent = 'Cloud mode sends tab titles (up to 160 characters) and host/path hints to Google Gemini when you group.';
    if (hasGeminiKey) {
      renderConfiguredProvider(config, lastRun, provider, syncSettings.geminiModel || config.defaultModel);
    } else {
      engineBadge.className = 'badge danger';
      engineBadge.textContent = 'Key missing';
    }
  } else if (config.mode === 'anthropic') {
    engineHint.classList.remove('hidden');
    engineHint.textContent = `Cloud mode sends tab titles (up to 160 characters) and host/path hints to ${config.name} when you group.`;
    // Without the optional host permission a cleanup sends nothing (D48).
    const access = await hasProviderHostAccess(provider);
    if (revision !== engineStatusRevision) return;
    if (!access) {
      engineBadge.className = 'badge warning';
      engineBadge.textContent = 'Access needed';
      engineHint.textContent = HOST_ACCESS_HINT;
    } else if (secrets[providerSettingKey(provider, 'apiKey')]) {
      renderConfiguredProvider(config, lastRun, provider, syncSettings[providerSettingKey(provider, 'model')] || config.defaultModel);
    } else {
      engineBadge.className = 'badge danger';
      engineBadge.textContent = 'Key missing';
    }
  } else if (config.mode === 'compatible') {
    engineHint.classList.remove('hidden');
    const endpoint = requestEndpoint(syncSettings, provider);
    if (!endpoint) {
      modelReasoningSummary.classList.add('hidden');
      engineHint.textContent = OLLAMA_REFUSED_HINT;
      engineBadge.className = 'badge ready';
      engineBadge.textContent = 'Local';
      return;
    }
    // Only Ollama keeps a saved address; a fixed provider is named alone.
    engineHint.textContent = isLoopbackUrl(endpoint)
      ? 'Sends tab titles and host/path hints to the Ollama server on this device when you group. That server can itself run cloud models.'
      : `Cloud mode sends tab titles (up to 160 characters) and host/path hints to ${config.name}${provider === 'ollama' ? ` at ${new URL(endpoint).host}` : ''} when you group.`;
    const apiKey = secrets[providerSettingKey(provider, 'apiKey')];
    const hasAuth = Boolean(apiKey || (provider === 'openai' && secrets.openaiOAuthToken));
    if (provider === 'openai' && isOpenAIResponsesOnlyModel(syncSettings.openaiModel || config.defaultModel)) {
      engineBadge.className = 'badge danger';
      engineBadge.textContent = 'Model unavailable';
      engineHint.textContent = 'Choose an OpenAI Chat Completions model in settings.';
    } else if (hasAuth || config.keyOptional) {
      renderConfiguredProvider(config, lastRun, provider, syncSettings[providerSettingKey(provider, 'model')] || config.defaultModel);
    } else {
      engineBadge.className = 'badge danger';
      engineBadge.textContent = 'Key missing';
    }
  } else if (provider === 'offline') {
    engineHint.classList.add('hidden');
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

/** Setup choice that matches a saved engine: cloud, offline, or keep (Ollama). */
function setupChoiceFor(provider) {
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
  const settings = await chrome.storage.sync.get(['setupChoice', 'provider', OLLAMA_BASE_URL_KEY]);
  if (settings.setupChoice) {
    setupCard.classList.add('hidden');
    return;
  }
  // A saved engine that no longer exists (Gemini Nano) shows as Offline smart mode.
  const current = settings.provider ? setupChoiceFor(resolveProvider(settings.provider)) : null;
  setupChoices.forEach(choice => {
    if (choice === setupKeepChoice) return;
    const isCurrent = choice.dataset.choice === current;
    if (isCurrent) choice.setAttribute('aria-current', 'true');
    else choice.removeAttribute('aria-current');
    choice.querySelector('.setup-pill.current')?.classList.toggle('hidden', !isCurrent);
  });
  setupKeepChoice.classList.toggle('hidden', current !== 'keep');
  // Ollama at another address is not on this device: say where titles go.
  const ollamaEndpoint = requestEndpoint(settings, 'ollama');
  setupKeepCopy.textContent = current !== 'keep' || (ollamaEndpoint && isLoopbackUrl(ollamaEndpoint))
    ? 'Runs through the Ollama server on this device, which can itself run cloud models.'
    : ollamaEndpoint
      ? 'Runs through your Ollama server at another address. Page titles and a short site hint are sent to it when you group.'
      : OLLAMA_REFUSED_HINT;
  setupCard.classList.remove('hidden');
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

/** The cloud engine a setup click would use: the current one, OpenAI, then any other with a saved key. */
function keyedCloudProvider(settings) {
  const hasKey = id => Boolean(settings[apiKeyStorageKey(id)] || (id === 'openai' && settings.openaiOAuthToken));
  return [settings.provider, 'openai', ...CLOUD_PROVIDERS]
    .find(id => CLOUD_PROVIDERS.includes(id) && hasKey(id));
}

/**
 * Cloud: reuse a key already saved for the current or another cloud engine
 * (presence only; the value is never shown). Without one, keep the engine
 * unchanged and open Settings so the user can add a key.
 */
async function chooseCloudSetup() {
  // Anthropic's host is optional: ask on this click, first and synchronously,
  // from the settings the status already loaded (the user's gesture ends at
  // the first slow await). A saved key the popup had not seen is asked for below.
  const guess = loadedSettings ? keyedCloudProvider(loadedSettings) : null;
  let access = guess ? requestProviderHostAccess(guess) : null;
  const secrets = await loadSettings();
  const keyed = keyedCloudProvider(secrets);
  if (keyed) {
    if (keyed !== guess) access = requestProviderHostAccess(keyed);
    await saveEngineChoice({ provider: keyed, setupChoice: 'cloud' });
    finishSetup(await access
      ? `${PROVIDER_CATALOG[keyed].name} selected with your saved key.`
      : `${PROVIDER_CATALOG[keyed].name} selected. Allow its access in Settings; until then cleanups run locally.`);
    return;
  }
  await saveEngineChoice({ setupChoice: 'cloud' });
  finishSetup('Add an API key in Settings to finish.');
  await openEngineSettings();
}

async function chooseSetup(choice) {
  if (choice === 'cloud') {
    await chooseCloudSetup();
  } else if (choice === 'offline') {
    await saveEngineChoice({ provider: 'offline', setupChoice: 'offline' });
    finishSetup('Offline mode selected. Tabs are grouped on this computer.');
  } else if (choice === 'keep') {
    const settings = await chrome.storage.sync.get(['provider', OLLAMA_BASE_URL_KEY]);
    await saveEngineChoice({ setupChoice: isLocalOllama(settings) ? 'offline' : 'cloud' });
    finishSetup('Keeping Ollama.');
  }
}

setupChoices.forEach(choice => choice.addEventListener('click', async () => {
  if (setupBusy) return;
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
 * The upkeep line: the last model plan kept and its new tabs placed on this
 * device. Only what happened, then that no request was sent.
 */
function upkeepLine(res) {
  const attached = Number(res.upkeepAttached) || 0;
  const review = Number(res.upkeepReview) || 0;
  const loose = Number(res.unplacedTabs) || 0;
  const added = [
    attached > 0 ? `${attached === 1 ? '1 new tab' : `${attached} new tabs`} to existing groups` : '',
    review > 0 ? `${review === 1 ? '1 tab' : `${review} tabs`} to Review Later` : ''
  ].filter(Boolean);
  const clauses = [
    added.length > 0 ? `Added ${added.join(', ')}` : '',
    loose > 0 ? `${loose === 1 ? '1 tab' : `${loose} tabs`} left ungrouped` : ''
  ].filter(Boolean);
  return `${clauses.length > 0 ? clauses.join('; ') : 'Kept the groups'}; no request sent.`;
}

// Event: Group tabs with actionable fallback diagnostics
btnGroupTabs.addEventListener('click', async () => {
  showStatus('Analyzing tabs & organizing...', 'loading');
  cleanupRunning = true;
  planEventDuringCleanup = false;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    noteActiveTab(activeTab);
    planPendingWindowId = null;

    // Every engine runs in the background worker. It owns the grouping lock
    // and pauses Auto-group while the cleanup runs.
    const response = await chrome.runtime.sendMessage({
      type: 'TRIGGER_GROUPING',
      windowId: activeTab?.windowId
    });
    // A refused run (busy) leaves any offer strip as it was.
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
    // Duplicates are closed before the offer or pending request is checked.
    const unchangedLead = duplicates > 0 ? duplicateSummary.trim() : 'Nothing changed.';
    if (res.planOffer) {
      // The window is unchanged and its late plan is still waiting.
      showPlanOffer(true);
      showStatus(`${unchangedLead} The late grouping for this window is waiting below.`, 'warning');
      hideStatusAfter(4500);
      return;
    }
    showPlanOffer(false);
    if (res.planPending && res.groupsCreated === 0) {
      // The late request for this unchanged window is still out; nothing was sent or moved.
      planPendingWindowId = res.windowId ?? popupWindowId;
      showStatus(`${unchangedLead} The model is still answering; its grouping will be offered here.`, 'warning');
      return;
    }

    if (res.source === 'plan-upkeep') {
      showStatus(`${upkeepLine(res)}${duplicateSummary}`, 'success');
      refreshTabCount();
      refreshStats();
      hideStatusAfter(3500);
      return;
    }

    if (res.groupsCreated === 0) {
      if (duplicates > 0) {
        showStatus(`Cleanup complete.${duplicateSummary}`, 'success');
      } else {
        showStatus(res.message || 'Need at least 2 unpinned tabs to create groups.', 'warning');
      }
      hideStatusAfter(3500);
      return;
    }

    const unplaced = Number(res.unplacedTabs) || 0;
    const unplacedNote = unplaced > 0
      ? ` ${unplaced === 1 ? '1 tab' : `${unplaced} tabs`} left ungrouped.`
      : '';
    if (res.planReviewOnly) {
      // A valid answer, not a provider failure: the model filed everything under Review Later.
      showStatus(`No usable task group survived validation, only Review Later. Created ${res.groupsCreated} groups locally.${duplicateSummary}`, 'warning');
    } else if (res.fallbackUsed) {
      let reasonSnippet = 'AI unavailable';
      if (res.fallbackCode === 'quota') {
        reasonSnippet = 'AI quota exceeded';
      } else if (res.fallbackCode === 'auth') {
        reasonSnippet = 'API key missing or rejected';
      } else if (res.fallbackCode === 'timeout') {
        reasonSnippet = 'AI timed out';
      } else if (res.fallbackCode === 'permission') {
        reasonSnippet = 'access not allowed; allow it in Settings';
      } else if (res.fallbackCode === 'refusal') {
        reasonSnippet = 'the provider declined this window';
      } else if (res.fallbackCode === 'max_tokens') {
        reasonSnippet = 'the answer was cut off';
      }
      showStatus(`Created ${res.groupsCreated} groups offline (${reasonSnippet}).${duplicateSummary}`, 'warning');
    } else {
      const notes = unplacedNote
        + (res.planPending ? ' The model is still answering; its grouping will be offered here.' : '');
      if (res.planPending) planPendingWindowId = res.windowId ?? popupWindowId;
      // 'oversized' alone is a diagnostic, not something to review.
      const review = (res.qualityCodes || []).some(code => REVIEW_CODES.has(code));
      showStatus(
        `Created ${res.groupsCreated} groups${review ? '; review recommended' : ''}.${duplicateSummary}${notes}`,
        review ? 'warning' : 'success'
      );
    }

    refreshTabCount();
    refreshStats();
    if (!res.planPending) hideStatusAfter(3500);
  } catch (error) {
    showStatus(error.message || 'Grouping failed. Check options.', 'error');
  } finally {
    cleanupRunning = false;
    // A late plan announced or failed before the response: settle from the verified lookup.
    if (planEventDuringCleanup) {
      planEventDuringCleanup = false;
      await settlePlan(popupWindowId).catch(() => {});
    }
  }
});

// Event: Apply a late plan. The background checks the window is unchanged.
btnApplyPlan.addEventListener('click', async () => {
  btnApplyPlan.disabled = true;
  showStatus('Applying the late grouping...', 'loading');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'APPLY_PLAN_OFFER', windowId: popupWindowId });
    if (!response?.success) throw new Error(response?.error || 'Could not apply the late grouping');
    const res = response.result;
    showPlanOffer(false);
    if (res?.success) {
      showStatus(`Applied the late grouping: ${res.groupsCreated} groups.`, 'success');
      refreshTabCount();
      refreshStats();
    } else if (res?.reason === 'changed') {
      showStatus('The window changed, so the late grouping was dropped. Run a cleanup again.', 'warning');
    } else if (res?.reason === 'failed') {
      if (!res.groupsCreated) showPlanOffer(true);
      // Chrome can create some groups before refusing the rest.
      showStatus(res.groupsCreated > 0
        ? `Chrome applied only part of the late grouping: ${res.groupsCreated === 1 ? '1 group' : `${res.groupsCreated} groups`} created.`
        : res.message || 'Chrome refused the late grouping, so it was not applied.', 'error');
    } else {
      showStatus('No late grouping is waiting for this window.', 'warning');
    }
    hideStatusAfter(4500);
  } catch (error) {
    btnApplyPlan.disabled = false;
    showStatus(error.message || 'Could not apply the late grouping.', 'error');
  }
});

// A late plan that lands or fails while the popup is open: re-read it through
// the verified lookup, which drops it if the window changed meanwhile, and end
// the status's promise. During a cleanup the event waits for its response.
chrome.runtime.onMessage?.addListener(message => {
  if (!Number.isInteger(message?.windowId) || message.windowId !== popupWindowId || popupIncognito) return;
  if (message.type !== 'PLAN_OFFER_READY' && message.type !== 'PLAN_OFFER_FAILED') return;
  if (cleanupRunning) {
    planEventDuringCleanup = true;
    return;
  }
  settlePlan(message.windowId).catch(() => {});
});

// Event: Ungroup
btnUngroup.addEventListener('click', async () => {
  showStatus('Ungrouping tabs...', 'loading');
  chrome.runtime.sendMessage({ type: 'UNGROUP_ALL' }, (response) => {
    if (response?.success) {
      // Ungroup ends the window's late plan and clears its offer.
      planPendingWindowId = null;
      showPlanOffer(false);
      const count = Number(response.result?.ungroupedCount);
      showStatus(Number.isFinite(count) ? `Ungrouped ${count === 1 ? '1 tab' : `${count} tabs`}` : 'Groups removed', 'success');
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
  // First, while the change is still the user's gesture (D48).
  const access = requestProviderHostAccess(newProvider);
  await saveEngineChoice({ provider: newProvider });
  await access;
  await refreshEngineStatus();
});

// A grant or removal made elsewhere (Settings, chrome://extensions) shows at once.
chrome.permissions?.onAdded?.addListener(() => refreshEngineStatus());
chrome.permissions?.onRemoved?.addListener(() => refreshEngineStatus());

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
    if (changes.setupChoice || changes.provider || changes[OLLAMA_BASE_URL_KEY]) {
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
  // Opening the popup prepares nothing: it only reads a late plan waiting for this window.
  chrome.tabs.query({ active: true, lastFocusedWindow: true })
    .then(([activeTab]) => {
      noteActiveTab(activeTab);
      return refreshPlanOffer(popupWindowId);
    })
    .catch(() => {});
  // The footer shows the installed version; the HTML holds the same text as a fallback.
  const version = chrome.runtime.getManifest?.()?.version;
  const versionLabel = document.getElementById('appVersion');
  if (version && versionLabel) versionLabel.textContent = `Foldnex ${version.split('.').slice(0, 2).join('.')}`;
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
