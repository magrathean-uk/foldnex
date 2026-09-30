/**
 * Foldnex - Options & Settings Controller
 */

import { ExactResultCache, LearningCache, safeGlobToRegExp } from '../src/cache-engine.js';
import {
  checkChromeNanoStatus,
  prepareChromeNano,
  CHROME_GROUP_COLORS,
  PROVIDER_CATALOG,
  labelTabsWithAI,
  getEffectiveReasoningEffort,
  getReasoningEffortOptions,
  isOpenAIResponsesOnlyModel,
  listProviderModels,
  providerSettingKey
} from '../src/ai-engine.js';
import { isOnDeviceEngine } from '../src/background-classifier.js';
import { loadSettings as loadSavedSettings, saveProviderSecrets } from '../src/settings.js';
import { PROVIDER_USAGE_KEY, readProviderUsageSummary, clearProviderUsage } from '../src/provider-usage.js';

// DOM elements - Navigation
const navItems = document.querySelectorAll('.nav-item');
const tabPanels = document.querySelectorAll('.tab-panel');
const toast = document.getElementById('toast');

// Provider elements
const providerPicker = document.getElementById('providerPicker');
const providerSelector = document.getElementById('providerSelector');
const providerSelectorName = document.getElementById('providerSelectorName');
const providerSelectorDescription = document.getElementById('providerSelectorDescription');
const providerSelectorMode = document.getElementById('providerSelectorMode');
const providerSelectorAction = document.getElementById('providerSelectorAction');
const providerList = document.getElementById('providerList');
const panelNanoDetails = document.getElementById('panel-nano-details');
const panelGeminiDetails = document.getElementById('panel-gemini-details');
const panelCompatibleDetails = document.getElementById('panel-compatible-details');
const panelOfflineDetails = document.getElementById('panel-offline-details');

const nanoStatusText = document.getElementById('nanoStatusText');
const btnRecheckNano = document.getElementById('btnRecheckNano');
const nanoRequirements = document.getElementById('nanoRequirements');

// Gemini fields
const geminiApiKey = document.getElementById('geminiApiKey');
const geminiModel = document.getElementById('geminiModel');
const geminiReasoningEffort = document.getElementById('geminiReasoningEffort');
const geminiReasoningHelp = document.getElementById('geminiReasoningHelp');
const geminiModelOptions = document.getElementById('geminiModelOptions');
const geminiCustomModel = document.getElementById('geminiCustomModel');
const geminiModelsStatus = document.getElementById('geminiModelsStatus');
const btnRefreshGeminiModels = document.getElementById('btnRefreshGeminiModels');
const btnToggleGeminiKey = document.getElementById('btnToggleGeminiKey');
const btnSaveGemini = document.getElementById('btnSaveGemini');
const btnTestGemini = document.getElementById('btnTestGemini');

// OpenAI-compatible provider fields
const compatibleProviderTitle = document.getElementById('compatibleProviderTitle');
const compatibleApiKeyLabel = document.getElementById('compatibleApiKeyLabel');
const compatibleApiKey = document.getElementById('compatibleApiKey');
const compatibleModel = document.getElementById('compatibleModel');
const compatibleReasoningEffort = document.getElementById('compatibleReasoningEffort');
const openaiPrioritySection = document.getElementById('openaiPrioritySection');
const prefOpenaiPriority = document.getElementById('prefOpenaiPriority');
const cloudCostSettings = document.getElementById('cloudCostSettings');
const prefCloudEconomy = document.getElementById('prefCloudEconomy');
const prefAutoGroup = document.getElementById('prefAutoGroup');
const compatibleReasoningHelp = document.getElementById('compatibleReasoningHelp');
const compatibleModelOptions = document.getElementById('compatibleModelOptions');
const compatibleCustomModel = document.getElementById('compatibleCustomModel');
const compatibleModelsStatus = document.getElementById('compatibleModelsStatus');
const btnRefreshCompatibleModels = document.getElementById('btnRefreshCompatibleModels');
const compatibleBaseUrl = document.getElementById('compatibleBaseUrl');
const openaiOAuthToken = document.getElementById('openaiOAuthToken');
const oauthSection = document.getElementById('oauthSection');
const btnToggleCompatibleKey = document.getElementById('btnToggleCompatibleKey');
const btnSaveCompatible = document.getElementById('btnSaveCompatible');
const btnTestCompatible = document.getElementById('btnTestCompatible');

// Rules elements
const rulesTableBody = document.getElementById('rulesTableBody');
const noRulesMsg = document.getElementById('noRulesMsg');
const searchRulesInput = document.getElementById('searchRulesInput');
const newRulePattern = document.getElementById('newRulePattern');
const newRuleCategory = document.getElementById('newRuleCategory');
const newRuleColor = document.getElementById('newRuleColor');
const btnAddRule = document.getElementById('btnAddRule');
const btnClearRules = document.getElementById('btnClearRules');
const btnExportRules = document.getElementById('btnExportRules');
const btnImportRules = document.getElementById('btnImportRules');
const importFileInput = document.getElementById('importFileInput');

// Behavior elements
const prefOneClickMode = document.getElementById('prefOneClickMode');
const prefCollapseGroups = document.getElementById('prefCollapseGroups');
const groupingStrategyInputs = document.querySelectorAll('input[name="groupingStrategy"]');
const diagEngine = document.getElementById('diagEngine');
const diagSource = document.getElementById('diagSource');
const diagOutcome = document.getElementById('diagOutcome');
const diagTokens = document.getElementById('diagTokens');
const diagLatency = document.getElementById('diagLatency');
const diagQuality = document.getElementById('diagQuality');
const btnClearDiagnostics = document.getElementById('btnClearDiagnostics');
const diagFallback = document.getElementById('diagFallback');
const diagReasoning = document.getElementById('diagReasoning');
const diagReasoningTokens = document.getElementById('diagReasoningTokens');
const usageRequests = document.getElementById('usageRequests');
const usageTokens = document.getElementById('usageTokens');
const usageCache = document.getElementById('usageCache');
const usageProviders = document.getElementById('usageProviders');
const usageReasoning = document.getElementById('usageReasoning');
const usageCoverage = document.getElementById('usageCoverage');
const btnClearProviderUsage = document.getElementById('btnClearProviderUsage');
const autoGroupPrepNote = document.getElementById('autoGroupPrepNote');

// On-device background preparation and model memory
const pendingEngineNote = document.getElementById('pendingEngineNote');
const onDeviceSettings = document.getElementById('onDeviceSettings');
const prefBackgroundPrep = document.getElementById('prefBackgroundPrep');
const backgroundPrepHelp = document.getElementById('backgroundPrepHelp');
const backgroundPrepAutoNote = document.getElementById('backgroundPrepAutoNote');
const modelUnloadRow = document.getElementById('modelUnloadRow');
const prefModelUnloadAfter = document.getElementById('prefModelUnloadAfter');
const modelMemoryRow = document.getElementById('modelMemoryRow');
const modelStateLine = document.getElementById('modelStateLine');
const btnFreeModelMemory = document.getElementById('btnFreeModelMemory');

let cachedRules = [];
let selectedCompatibleProvider = 'openai';
let selectedProvider = 'gemini_nano';
let providerTransitionId = 0;
let lastNanoStatus = 'checking';
// Engine whose settings are shown; differs from the saved one only while Cloud setup waits for a key.
let panelProvider = 'gemini_nano';
let savedProvider = 'gemini_nano';
let pendingCloudProvider = null;
let savedOllamaBaseUrl = '';
let autoGroupOn = false;
let modelStateTimer = null;
let modelStateBusy = false;
const catalogRevisions = { gemini: 0, compatible: 0 };
const connectionRevisions = { gemini: 0, compatible: 0 };
let compatibleLoadRevision = 0;
const MODEL_STATE_POLL_MS = 5000;
const MODEL_UNLOAD_VALUES = ['immediately', '2m', '5m', '15m', '60m', 'never'];
const OLLAMA_BASE_URL_KEY = providerSettingKey('ollama', 'baseUrl');
const NANO_PREP_HELP = 'Labels tabs as they load, so a later cleanup can use saved labels. Uses about 3 GB of memory while the model is loaded, and some CPU when tabs change. Turn off to start labelling when you clean up: tabs the model has not reached yet are placed by site first, then labelled in the background for a later cleanup.';
const OLLAMA_PREP_HELP = 'Labels tabs as they load, so a later cleanup can use saved labels. Keeps the Ollama model in memory and uses some CPU when tabs change. Turn off to start labelling when you clean up: tabs the model has not reached yet are placed by site first, then labelled in the background for a later cleanup.';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * Display toast notification
 */
function showToast(msg, type = 'success') {
  clearTimeout(showToast.timer);
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  toast.classList.remove('hidden');
  showToast.timer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 3500);
}

/**
 * Switch tabs in options layout
 */
function activateSettingsTab(item) {
  navItems.forEach(navItem => {
    const active = navItem === item;
    navItem.classList.toggle('active', active);
    navItem.setAttribute('aria-selected', String(active));
    navItem.tabIndex = active ? 0 : -1;
  });
  tabPanels.forEach(panel => panel.classList.toggle('active', panel.id === `tab-${item.dataset.tab}`));
  requestAnimationFrame(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  });
  syncModelStatePolling();
}

navItems.forEach((item, index) => {
  item.addEventListener('click', () => activateSettingsTab(item));
  item.addEventListener('keydown', event => {
    let nextIndex;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % navItems.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + navItems.length) % navItems.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = navItems.length - 1;
    else return;
    event.preventDefault();
    activateSettingsTab(navItems[nextIndex]);
    navItems[nextIndex].focus();
  });
});

function renderProviderList() {
  providerList.textContent = '';
  Object.entries(PROVIDER_CATALOG).forEach(([id, provider]) => {
    const label = document.createElement('label');
    label.className = 'provider-row';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'providerSelect';
    radio.value = id;

    const copy = document.createElement('span');
    copy.className = 'provider-row-copy';
    const name = document.createElement('strong');
    name.textContent = provider.name;
    const description = document.createElement('span');
    description.textContent = provider.description;
    copy.append(name, description);

    const mode = document.createElement('span');
    mode.className = 'status-pill';
    mode.textContent = provider.mode === 'local' || provider.local ? 'Local' : 'Cloud';
    if (id === 'gemini_nano') mode.id = 'nanoBadge';

    label.append(radio, copy, mode);
    providerList.append(label);
  });
}

function getProviderRadios() {
  return document.querySelectorAll('input[name="providerSelect"]');
}

function providerPanel(provider) {
  const config = PROVIDER_CATALOG[provider];
  if (provider === 'gemini_nano') return panelNanoDetails;
  if (provider === 'gemini_api') return panelGeminiDetails;
  if (provider === 'offline') return panelOfflineDetails;
  if (config?.mode === 'compatible') return panelCompatibleDetails;
  return null;
}

function syncProviderSelector(provider) {
  const config = PROVIDER_CATALOG[provider];
  if (!config) return;
  selectedProvider = provider;
  providerSelectorName.textContent = config.name;
  providerSelectorDescription.textContent = config.description;
  providerSelectorMode.textContent = config.mode === 'local' || config.local ? 'Local' : 'Cloud';
}

function setProviderPickerA11y(collapsed) {
  providerSelector.setAttribute('aria-expanded', String(!collapsed));
  providerSelectorAction.textContent = collapsed ? 'Change' : 'Close';
  providerList.toggleAttribute('inert', collapsed);
  providerList.setAttribute('aria-hidden', String(collapsed));
}

function waitForMotion(duration) {
  return new Promise(resolve => setTimeout(resolve, duration));
}

function animateProviderRowsIntoSelector(provider) {
  const target = providerSelector.getBoundingClientRect();
  const targetX = target.left + Math.min(target.width * .56, 320);
  const targetY = target.top + target.height / 2;
  return [...providerList.querySelectorAll('.provider-row')].map((row, index) => {
    const rect = row.getBoundingClientRect();
    const dx = targetX - (rect.left + rect.width / 2);
    const dy = targetY - (rect.top + rect.height / 2);
    const isSelected = row.querySelector('input')?.value === provider;
    return row.animate([
      {
        transform: 'translate(0, 0) scale(1)',
        opacity: 1,
        filter: 'blur(0)',
        clipPath: 'inset(0 round 10px)'
      },
      {
        offset: .7,
        transform: `translate(${dx * .7}px, ${dy * .72}px) scale(${isSelected ? .94 : .88}, .52)`,
        opacity: isSelected ? .82 : .38,
        filter: 'blur(.5px)',
        clipPath: 'inset(18% 4% round 10px)'
      },
      {
        transform: `translate(${dx}px, ${dy}px) scale(.7, .12)`,
        opacity: 0,
        filter: 'blur(1.5px)',
        clipPath: 'inset(46% 10% round 10px)'
      }
    ], {
      duration: isSelected ? 320 : 260,
      delay: Math.min(index * 16, 128),
      easing: 'cubic-bezier(.16, 1, .3, 1)',
      fill: 'forwards'
    });
  });
}

function animateProviderRowsOutOfSelector() {
  return [...providerList.querySelectorAll('.provider-row')].map((row, index) => row.animate([
    {
      transform: 'translateY(-12px) scale(.985)',
      opacity: 0,
      clipPath: 'inset(42% 7% round 10px)'
    },
    {
      transform: 'translateY(0) scale(1)',
      opacity: 1,
      clipPath: 'inset(0 round 10px)'
    }
  ], {
    duration: 240,
    delay: Math.min(index * 14, 112),
    easing: 'cubic-bezier(.16, 1, .3, 1)'
  }));
}

function focusProviderDetails(provider) {
  const panel = providerPanel(provider);
  if (!panel || !document.getElementById('tab-providers')?.classList.contains('active')) return;

  panel.classList.remove('is-provider-entering');
  requestAnimationFrame(() => {
    panel.classList.add('is-provider-entering');
    let target = panel;
    if (provider === 'gemini_api') target = geminiApiKey;
    if (PROVIDER_CATALOG[provider]?.mode === 'compatible') {
      target = PROVIDER_CATALOG[provider].keyOptional ? compatibleModel : compatibleApiKey;
    }
    if (provider === 'gemini_nano' && !btnRecheckNano.disabled && !btnRecheckNano.classList.contains('hidden')) target = btnRecheckNano;
    target.focus({ preventScroll: true });
    panel.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'nearest' });
    setTimeout(() => panel.classList.remove('is-provider-entering'), 420);
  });
}

async function collapseProviderPicker(provider, { animate = false, focusDetails = false } = {}) {
  const transitionId = ++providerTransitionId;
  syncProviderSelector(provider);
  setProviderPickerA11y(true);

  const shouldAnimate = animate && !reducedMotion.matches && !providerPicker.classList.contains('is-collapsed');
  providerPicker.classList.add('is-animating');
  providerSelector.disabled = true;
  const animations = shouldAnimate ? animateProviderRowsIntoSelector(provider) : [];

  if (shouldAnimate) {
    requestAnimationFrame(() => providerPicker.classList.add('is-collapsed'));
  } else {
    providerPicker.classList.add('is-collapsed');
  }
  if (shouldAnimate) {
    await Promise.all([
      ...animations.map(animation => animation.finished.catch(() => undefined)),
      waitForMotion(360)
    ]);
  }

  if (transitionId !== providerTransitionId) return;
  animations.forEach(animation => animation.cancel());
  providerPicker.classList.remove('is-animating');
  providerPicker.classList.add('is-ready');
  providerSelector.disabled = false;
  if (focusDetails) focusProviderDetails(provider);
}

async function expandProviderPicker() {
  if (!providerPicker.classList.contains('is-collapsed')) return;
  const transitionId = ++providerTransitionId;
  setProviderPickerA11y(false);
  providerPicker.classList.remove('is-collapsed');

  let animations = [];
  if (!reducedMotion.matches) {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    animations = animateProviderRowsOutOfSelector();
    await Promise.all(animations.map(animation => animation.finished.catch(() => undefined)));
  }

  if (transitionId !== providerTransitionId) return;
  animations.forEach(animation => animation.cancel());
  const selectedRadio = document.querySelector(`input[name="providerSelect"][value="${selectedProvider}"]`);
  selectedRadio?.focus({ preventScroll: true });
}

function modelUi(provider) {
  if (provider === 'gemini_api') {
    return {
      input: geminiModel,
      options: geminiModelOptions,
      custom: geminiCustomModel,
      status: geminiModelsStatus,
      button: btnRefreshGeminiModels
    };
  }
  return {
    input: compatibleModel,
    options: compatibleModelOptions,
    custom: compatibleCustomModel,
    status: compatibleModelsStatus,
    button: btnRefreshCompatibleModels
  };
}

function catalogSlot(provider) {
  return provider === 'gemini_api' ? 'gemini' : 'compatible';
}

function catalogProviderCurrent(provider) {
  return panelProvider === provider && (provider === 'gemini_api' || selectedCompatibleProvider === provider);
}

// These request snapshots stay in this page's memory. Credentials never enter
// model catalog storage, diagnostics, or UI messages.
function catalogContext(provider) {
  const config = PROVIDER_CATALOG[provider];
  return {
    provider,
    apiKey: provider === 'gemini_api'
      ? geminiApiKey.value.trim()
      : compatibleApiKey.value.trim() || (provider === 'openai' ? openaiOAuthToken.value.trim() : ''),
    baseUrl: provider === 'gemini_api' ? '' : compatibleBaseUrl.value.trim() || config.baseUrl
  };
}

function catalogContextCurrent(context) {
  if (!catalogProviderCurrent(context.provider)) return false;
  const current = catalogContext(context.provider);
  return current.apiKey === context.apiKey && current.baseUrl === context.baseUrl;
}

function renderModelOptions(provider, models, fetchedAt = 0) {
  if (!catalogProviderCurrent(provider)) return;
  const ui = modelUi(provider);
  ui.options.textContent = '';
  const custom = document.createElement('option');
  custom.value = '';
  custom.textContent = 'Custom model…';
  ui.options.append(custom);
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    ui.options.append(option);
  }
  const selected = ui.input.value.trim();
  const listed = models.includes(selected);
  ui.options.value = listed ? selected : '';
  ui.custom.classList.toggle('hidden', listed);
  if (!models.length) return;
  const age = fetchedAt ? ` · updated ${new Date(fetchedAt).toLocaleString()}` : '';
  ui.status.textContent = `${models.length} model${models.length === 1 ? '' : 's'} from the provider${age}. Choose one or enter a custom ID; your model changes only when you save.`;
}

function invalidateModelCatalog(provider) {
  if (!PROVIDER_CATALOG[provider] || !['gemini', 'compatible'].includes(PROVIDER_CATALOG[provider].mode)) return;
  const slot = catalogSlot(provider);
  catalogRevisions[slot]++;
  connectionRevisions[slot]++;
  if (!catalogProviderCurrent(provider)) return;
  const ui = modelUi(provider);
  renderModelOptions(provider, []);
  ui.button.disabled = false;
  ui.button.textContent = 'Refresh models';
  ui.status.textContent = 'Catalog needs refresh for the current connection settings.';
  const testButton = provider === 'gemini_api' ? btnTestGemini : btnTestCompatible;
  testButton.textContent = 'Test connection';
  testButton.disabled = provider === 'openai' && isOpenAIResponsesOnlyModel(ui.input.value.trim() || PROVIDER_CATALOG[provider].defaultModel);
}

async function refreshModelCatalog(provider) {
  const config = PROVIDER_CATALOG[provider];
  if (!config || !['gemini', 'compatible'].includes(config.mode) || !catalogProviderCurrent(provider)) return false;

  const ui = modelUi(provider);
  const slot = catalogSlot(provider);
  const revision = ++catalogRevisions[slot];
  const context = catalogContext(provider);
  const isCurrent = () => catalogRevisions[slot] === revision && catalogContextCurrent(context);
  // Provider-only persistent caches can belong to a different account or
  // endpoint. Catalog GETs always refresh; the selected model is preserved.
  renderModelOptions(provider, []);

  ui.button.disabled = true;
  ui.button.textContent = 'Loading…';
  ui.status.textContent = 'Loading the live model catalog…';
  try {
    const models = await listProviderModels(provider, context);
    if (!models.length) throw new Error('The provider returned no models');
    if (!isCurrent()) return false;
    renderModelOptions(provider, models, Date.now());
    return true;
  } catch (error) {
    if (isCurrent()) {
      ui.status.textContent = connectionErrorMessage(error, 'Model catalog request');
    }
    return false;
  } finally {
    if (isCurrent()) {
      ui.button.disabled = false;
      ui.button.textContent = 'Refresh models';
    }
  }
}

function renderReasoningControl(provider, model, select, help) {
  const options = getReasoningEffortOptions(provider, model);
  const effective = getEffectiveReasoningEffort(provider, model, select.dataset.saved);
  const responsesOnly = provider === 'openai' && isOpenAIResponsesOnlyModel(model);
  if (provider !== 'gemini_api') {
    btnSaveCompatible.disabled = responsesOnly;
    btnTestCompatible.disabled = responsesOnly;
  }
  select.textContent = '';

  if (options.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = responsesOnly
      ? 'Unavailable in Foldnex'
      : effective ? `${effective[0].toUpperCase()}${effective.slice(1)} · fixed` : 'Provider default';
    select.append(option);
    select.disabled = true;
    help.textContent = responsesOnly
      ? 'This model requires the OpenAI Responses API. Choose a Chat Completions model.'
      : effective
        ? 'This model alias uses a fixed Low setting. Choose a versioned model to adjust it.'
        : 'This model has no adjustable reasoning effort in Foldnex.';
    return;
  }

  for (const value of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = `${value[0].toUpperCase()}${value.slice(1)}`;
    select.append(option);
  }
  select.disabled = false;
  select.value = effective;
  help.textContent = 'Higher effort may take longer and use more tokens. Private reasoning text is not shown.';
}

geminiModel.addEventListener('input', () => {
  geminiModelOptions.value = '';
  renderReasoningControl('gemini_api', geminiModel.value.trim(), geminiReasoningEffort, geminiReasoningHelp);
});
compatibleModel.addEventListener('input', () => {
  compatibleModelOptions.value = '';
  renderReasoningControl(selectedCompatibleProvider, compatibleModel.value.trim(), compatibleReasoningEffort, compatibleReasoningHelp);
});

for (const provider of ['gemini_api', 'compatible']) {
  const ui = modelUi(provider);
  ui.options.addEventListener('change', () => {
    const id = provider === 'compatible' ? selectedCompatibleProvider : provider;
    const custom = !ui.options.value;
    ui.custom.classList.toggle('hidden', !custom);
    if (custom) ui.input.focus();
    else ui.input.value = ui.options.value;
    renderReasoningControl(id, ui.input.value.trim(), provider === 'compatible' ? compatibleReasoningEffort : geminiReasoningEffort,
      provider === 'compatible' ? compatibleReasoningHelp : geminiReasoningHelp);
  });
}

for (const [input, selected] of [
  [geminiApiKey, () => 'gemini_api'],
  [compatibleApiKey, () => selectedCompatibleProvider],
  [openaiOAuthToken, () => 'openai'],
  [compatibleBaseUrl, () => selectedCompatibleProvider]
]) {
  // Retire old requests immediately, but fetch only when an edit is committed.
  input.addEventListener('input', () => invalidateModelCatalog(selected()));
  input.addEventListener('change', () => refreshModelCatalog(selected()));
}
geminiReasoningEffort.addEventListener('change', () => {
  geminiReasoningEffort.dataset.saved = geminiReasoningEffort.value;
});
compatibleReasoningEffort.addEventListener('change', () => {
  compatibleReasoningEffort.dataset.saved = compatibleReasoningEffort.value;
});

async function loadCompatibleProvider(provider) {
  const config = PROVIDER_CATALOG[provider];
  if (!config || config.mode !== 'compatible') return;
  selectedCompatibleProvider = provider;
  const revision = ++compatibleLoadRevision;
  invalidateModelCatalog(provider);
  const loadingFields = [compatibleApiKey, compatibleModel, compatibleModelOptions, compatibleBaseUrl, openaiOAuthToken,
    compatibleReasoningEffort, prefOpenaiPriority];
  loadingFields.forEach(field => { field.disabled = true; });
  btnSaveCompatible.disabled = true;
  btnTestCompatible.disabled = true;
  btnRefreshCompatibleModels.disabled = true;
  compatibleApiKey.value = '';
  openaiOAuthToken.value = '';
  compatibleBaseUrl.value = config.baseUrl || '';
  compatibleModel.value = config.defaultModel || '';
  renderModelOptions(provider, []);

  let syncData;
  try {
    syncData = await loadSavedSettings();
  } catch {
    if (revision !== compatibleLoadRevision || !catalogProviderCurrent(provider)) return;
    loadingFields.forEach(field => { field.disabled = false; });
    renderReasoningControl(provider, compatibleModel.value, compatibleReasoningEffort, compatibleReasoningHelp);
    btnRefreshCompatibleModels.disabled = false;
    compatibleModelsStatus.textContent = 'Saved provider settings could not be loaded. Enter your connection settings.';
    return;
  }

  if (revision !== compatibleLoadRevision || !catalogProviderCurrent(provider)) return;

  compatibleProviderTitle.textContent = `${config.name} configuration`;
  compatibleApiKeyLabel.textContent = config.keyOptional ? 'API key (optional)' : `${config.name} API key`;
  compatibleApiKey.placeholder = config.keyOptional ? 'Optional for this local endpoint' : 'Paste provider key';
  compatibleApiKey.value = syncData[providerSettingKey(provider, 'apiKey')] || '';
  compatibleModel.value = syncData[providerSettingKey(provider, 'model')] || config.defaultModel || '';
  loadingFields.forEach(field => { field.disabled = false; });
  compatibleReasoningEffort.dataset.saved = syncData[providerSettingKey(provider, 'reasoningEffort')] || 'low';
  renderReasoningControl(provider, compatibleModel.value, compatibleReasoningEffort, compatibleReasoningHelp);
  compatibleBaseUrl.value = syncData[providerSettingKey(provider, 'baseUrl')] || config.baseUrl || '';
  oauthSection.classList.toggle('hidden', provider !== 'openai');
  openaiPrioritySection.classList.toggle('hidden', provider !== 'openai');
  prefOpenaiPriority.checked = syncData.openaiPriority !== false;
  if (provider === 'openai') {
    openaiOAuthToken.value = syncData.openaiOAuthToken || '';
  }
  compatibleModelsStatus.textContent = 'Loading the provider’s model catalog…';
  await refreshModelCatalog(provider);
}

/** Switch the single details area to the selected engine. */
function updateProviderPanels(provider) {
  const config = PROVIDER_CATALOG[provider];
  invalidateModelCatalog(panelProvider);
  compatibleLoadRevision++;
  panelProvider = provider;
  panelNanoDetails.classList.toggle('hidden', provider !== 'gemini_nano');
  panelGeminiDetails.classList.toggle('hidden', provider !== 'gemini_api');
  panelCompatibleDetails.classList.toggle('hidden', config?.mode !== 'compatible');
  panelOfflineDetails.classList.toggle('hidden', provider !== 'offline');
  renderOnDeviceSettings();
  if (provider === 'gemini_nano') refreshNanoDiagnostics();
  if (config?.mode === 'compatible') loadCompatibleProvider(provider);
  if (provider === 'gemini_api') refreshModelCatalog(provider);
}

function isCloudProvider(provider) {
  const config = PROVIDER_CATALOG[provider];
  return Boolean(config && (config.mode === 'gemini' || config.mode === 'compatible') && !config.local);
}

function onDeviceProvider(provider) {
  return isOnDeviceEngine({ provider, [OLLAMA_BASE_URL_KEY]: savedOllamaBaseUrl });
}

/**
 * Background preparation applies to on-device engines; the unload controls
 * only to Gemini Nano, whose sessions Foldnex holds.
 */
function renderOnDeviceSettings() {
  const nano = panelProvider === 'gemini_nano';
  cloudCostSettings.classList.toggle('hidden', panelProvider === 'offline' || onDeviceProvider(panelProvider));
  onDeviceSettings.classList.toggle('hidden', !onDeviceProvider(panelProvider));
  modelUnloadRow.classList.toggle('hidden', !nano);
  modelMemoryRow.classList.toggle('hidden', !nano);
  backgroundPrepHelp.textContent = nano ? NANO_PREP_HELP : OLLAMA_PREP_HELP;
  backgroundPrepAutoNote.classList.toggle('hidden', !autoGroupOn);
  prefBackgroundPrep.setAttribute('aria-describedby', autoGroupOn ? 'backgroundPrepHelp backgroundPrepAutoNote' : 'backgroundPrepHelp');
  autoGroupPrepNote.classList.toggle('hidden', !(autoGroupOn && onDeviceProvider(savedProvider)));
  syncModelStatePolling();
}

function renderPendingNote() {
  pendingEngineNote.classList.toggle('hidden', !pendingCloudProvider);
  if (!pendingCloudProvider) return;
  const current = PROVIDER_CATALOG[savedProvider]?.name || PROVIDER_CATALOG.gemini_nano.name;
  pendingEngineNote.textContent = `Foldnex keeps using ${current} until you save a key for ${PROVIDER_CATALOG[pendingCloudProvider].name}.`;
}

/** Finish Cloud setup: the engine becomes active once a key for it is saved. */
async function activatePendingProvider(provider) {
  await chrome.storage.sync.set({ provider });
  savedProvider = provider;
  pendingCloudProvider = null;
  renderPendingNote();
  renderOnDeviceSettings();
}

function modelStateText(state) {
  if (!state?.ok) return 'Model state unavailable';
  if (!state.loaded) return 'Model not loaded';
  if (!Number.isFinite(state.idleMs)) return 'Model loaded';
  const minutes = Math.floor(state.idleMs / 60000);
  if (minutes < 1) return 'Model loaded · idle under 1 min';
  if (minutes < 60) return `Model loaded · idle ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `Model loaded · idle ${hours} h ${minutes % 60} min`;
}

async function refreshModelState() {
  if (modelStateBusy) return;
  modelStateBusy = true;
  try {
    let state = null;
    try {
      state = await chrome.runtime.sendMessage({ type: 'GET_ON_DEVICE_MODEL_STATE' });
    } catch {
      state = null;
    }
    modelStateLine.textContent = modelStateText(state);
    btnFreeModelMemory.disabled = Boolean(state?.ok && !state.loaded);
  } finally {
    modelStateBusy = false;
  }
}

/** Poll the model state at most every 5 s, only while this page shows Nano's settings. */
function syncModelStatePolling() {
  const wanted = document.visibilityState === 'visible'
    && panelProvider === 'gemini_nano'
    && document.getElementById('tab-providers')?.classList.contains('active');
  if (!wanted) {
    clearInterval(modelStateTimer);
    modelStateTimer = null;
    return;
  }
  if (modelStateTimer) return;
  refreshModelState();
  modelStateTimer = setInterval(refreshModelState, MODEL_STATE_POLL_MS);
}
document.addEventListener('visibilitychange', syncModelStatePolling);

renderProviderList();
providerSelector.addEventListener('click', () => {
  if (providerPicker.classList.contains('is-collapsed')) {
    expandProviderPicker();
  } else {
    collapseProviderPicker(selectedProvider, { animate: true });
  }
});

getProviderRadios().forEach(radio => {
  radio.addEventListener('change', async (e) => {
    if (!e.target.checked) return;
    const provider = e.target.value;
    if (pendingCloudProvider && isCloudProvider(provider)) {
      // Cloud setup is still waiting for a key: show this engine without switching to it.
      pendingCloudProvider = provider;
      updateProviderPanels(provider);
      renderPendingNote();
      await collapseProviderPicker(provider, { animate: true, focusDetails: true });
      return;
    }
    pendingCloudProvider = null;
    renderPendingNote();
    savedProvider = provider;
    updateProviderPanels(provider);
    let saveError = null;
    let savePromise;
    try {
      savePromise = chrome.storage.sync.set({ provider }).catch(error => {
        saveError = error;
      });
    } catch (error) {
      saveError = error;
      savePromise = Promise.resolve();
    }
    await collapseProviderPicker(provider, { animate: true, focusDetails: true });
    await savePromise;
    if (!saveError) {
      showToast(`${PROVIDER_CATALOG[provider].name} selected.`);
    } else {
      showToast('The engine changed here, but Chrome could not save the selection.', 'error');
    }
  });
});

// Setup requirements apply until Chrome has made the model available.
function setNanoSetupVisible(visible) {
  nanoRequirements.classList.toggle('hidden', !visible);
  btnRecheckNano.classList.toggle('hidden', !visible);
}

/**
 * Check and refresh Gemini Nano diagnostic status (safe DOM updates, no innerHTML)
 */
async function refreshNanoDiagnostics() {
  const nanoBadge = document.getElementById('nanoBadge');
  nanoStatusText.textContent = 'Checking Chrome’s local model…';
  nanoBadge.className = 'status-pill checking';
  nanoBadge.textContent = 'Checking…';
  btnRecheckNano.disabled = true;
  btnRecheckNano.textContent = 'Checking…';
  setNanoSetupVisible(true);

  try {
    const status = await checkChromeNanoStatus();
    lastNanoStatus = status.status;
    nanoStatusText.textContent = '';

    if (status.status === 'ready') {
      nanoBadge.className = 'status-pill ready';
      nanoBadge.textContent = 'Available';
      setNanoSetupVisible(false);
      const strong = document.createElement('strong');
      strong.textContent = 'Local model available. ';
      nanoStatusText.append(strong, 'Chrome has downloaded it. If it needs loading, cleanup can use temporary local groups while it warms; run cleanup again to use the prepared labels.');
    } else if (status.status === 'downloadable') {
      nanoBadge.className = 'status-pill checking';
      nanoBadge.textContent = 'Download needed';
      btnRecheckNano.textContent = 'Download local model';
      const strong = document.createElement('strong');
      strong.textContent = 'One-time download required. ';
      nanoStatusText.append(strong, 'Start it below; Chrome keeps tab data on this device.');
    } else if (status.status === 'downloading') {
      nanoBadge.className = 'status-pill checking';
      nanoBadge.textContent = 'Downloading';
      btnRecheckNano.textContent = 'Resume model download';
      const strong = document.createElement('strong');
      strong.textContent = 'Chrome is downloading the local model. ';
      nanoStatusText.append(strong, 'You can keep this page open to follow progress.');
    } else {
      nanoBadge.className = 'status-pill checking';
      nanoBadge.textContent = 'Unavailable';
      btnRecheckNano.textContent = 'Check again';
      const strong = document.createElement('strong');
      strong.textContent = `${String(status.detail || 'Prompt API unavailable')}. `;
      nanoStatusText.append(strong, 'Check the requirements below or select another engine.');
    }
  } finally {
    btnRecheckNano.disabled = false;
  }
}

btnRecheckNano.addEventListener('click', async () => {
  if (!['downloadable', 'downloading'].includes(lastNanoStatus)) {
    await refreshNanoDiagnostics();
    return;
  }

  btnRecheckNano.disabled = true;
  btnRecheckNano.textContent = 'Preparing…';
  nanoStatusText.textContent = 'Starting Chrome’s local model download…';
  try {
    await prepareChromeNano(percent => {
      nanoStatusText.textContent = `Downloading local model… ${percent}%`;
    });
    showToast('Chrome Gemini Nano is available.');
  } catch (error) {
    showToast(`Local model setup failed: ${error.message}`, 'error');
  } finally {
    await refreshNanoDiagnostics();
  }
});

/**
 * Load initial settings; the shared loader migrates legacy synced credentials.
 */
async function loadSettings() {
  const syncData = await loadSavedSettings();

  const currentProvider = syncData.provider || 'gemini_nano';
  const matchingRadio = document.querySelector(`input[name="providerSelect"][value="${currentProvider}"]`);
  if (matchingRadio) matchingRadio.checked = true;
  savedProvider = currentProvider;
  savedOllamaBaseUrl = syncData[OLLAMA_BASE_URL_KEY] || '';
  autoGroupOn = Boolean(syncData.autoGroupNewTabs);
  prefBackgroundPrep.checked = syncData.backgroundPrep === true;
  prefCloudEconomy.checked = syncData.cloudEconomyMode === true;
  prefModelUnloadAfter.value = MODEL_UNLOAD_VALUES.includes(syncData.modelUnloadAfter) ? syncData.modelUnloadAfter : '5m';

  const geminiKey = syncData.geminiApiKey || '';
  if (geminiKey) geminiApiKey.value = geminiKey;
  geminiModel.value = syncData.geminiModel || PROVIDER_CATALOG.gemini_api.defaultModel;
  geminiReasoningEffort.dataset.saved = syncData.geminiReasoningEffort || 'low';
  renderReasoningControl('gemini_api', geminiModel.value, geminiReasoningEffort, geminiReasoningHelp);

  updateProviderPanels(currentProvider);
  await collapseProviderPicker(currentProvider);

  prefOneClickMode.checked = Boolean(syncData.oneClickIconMode);
  prefCollapseGroups.checked = Boolean(syncData.collapseGroupsOnCreation);
  prefAutoGroup.checked = Boolean(syncData.autoGroupNewTabs);
  const strategy = syncData.groupingStrategy === 'site' ? 'site' : 'task';
  const strategyInput = document.querySelector(`input[name="groupingStrategy"][value="${strategy}"]`);
  if (strategyInput) strategyInput.checked = true;

  await loadLearnedRules();
  await loadRunDiagnostics();
  await loadProviderUsage();
}

async function loadRunDiagnostics() {
  if (!diagEngine) return;
  const { foldnex_last_run: run } = await chrome.storage.local.get('foldnex_last_run');
  if (!run) {
    diagEngine.textContent = 'No run recorded';
    for (const field of [diagSource, diagOutcome, diagTokens, diagLatency, diagQuality, diagFallback, diagReasoning, diagReasoningTokens]) {
      field.textContent = '—';
    }
    return;
  }

  const providerName = PROVIDER_CATALOG[run.provider]?.name || run.provider || 'Unknown';
  diagEngine.textContent = run.strategy === 'site'
    ? 'Site categories · local'
    : run.model ? `${providerName} · ${run.model}` : providerName;
  const provisional = Number(run.provisionalTabs) || 0;
  const callKinds = ['label', 'naming', 'consolidation'];
  const modelCallCount = callKinds.reduce((total, kind) => total + (Number(run.modelCalls?.[kind]) || 0), 0);
  const recordedCallCount = callKinds.every(kind => Number.isFinite(run.modelCalls?.[kind]) && run.modelCalls[kind] >= 0);
  // A shared cloud response has no newly dispatched requests. Older records
  // with absent counters cannot establish a request count from source alone.
  const sharedCloudResult = run.source === 'cloud' && recordedCallCount && modelCallCount === 0;
  const hasTokenUsage = ['promptTokens', 'completionTokens', 'cachedTokens', 'cacheWriteTokens', 'reasoningTokens']
    .some(key => Number(run[key]) > 0);
  const didModelWork = modelCallCount > 0 || hasTokenUsage || (!sharedCloudResult && ['cloud', 'nano'].includes(run.source));
  const cloudWork = didModelWork && isCloudProvider(run.provider);
  const requestSummary = modelCallCount > 0
    ? ` · ${modelCallCount} ${cloudWork ? 'cloud' : 'model'} request${modelCallCount === 1 ? '' : 's'}`
    : sharedCloudResult ? ' · shared result · 0 new requests'
      : cloudWork ? ' · request count not recorded' : '';
  diagSource.textContent = `${String(run.source || 'unknown').replaceAll('-', ' ')}${requestSummary}${provisional > 0 ? ` · ${provisional} provisional` : ''}`;
  diagOutcome.textContent = `${run.tabsGrouped || 0} tabs · ${run.groupsCreated || 0} groups · ${run.duplicateTabsClosed || 0} duplicates`
    + (Number.isFinite(run.groupCeiling) ? ` · ${run.strategy === 'task' ? 'preferred target' : 'ceiling'} ${run.groupCeiling}` : '');
  diagTokens.textContent = hasTokenUsage
    ? `${run.promptTokens || 0} in · ${run.completionTokens || 0} out · ${run.cachedTokens || 0} cached`
    : sharedCloudResult ? 'No new request tokens · shared result'
      : didModelWork ? 'Provider usage not reported' : 'Local or cache result';
  diagLatency.textContent = run.latencyMs ? `${run.latencyMs} ms total` : '—';
  diagQuality.textContent = run.qualityFlags?.length ? run.qualityFlags.join(' · ') : 'Passed';
  diagFallback.textContent = run.fallbackDetail || run.fallbackCode || 'None';
  const inferredOffline = run.strategy === 'site' || ['offline', 'offline-fallback'].includes(run.source);
  const cachedWithoutModelWork = ['exact-cache', 'label-cache'].includes(run.source) && !didModelWork;
  let reasoningStatus = 'Provider default';
  if (sharedCloudResult) {
    reasoningStatus = run.reasoningEffort
      ? `${run.reasoningEffort[0].toUpperCase()}${run.reasoningEffort.slice(1)} · shared result`
      : 'Shared result · no new request';
  } else if (inferredOffline && !didModelWork) reasoningStatus = 'Not used · local grouping';
  else if (cachedWithoutModelWork) reasoningStatus = 'Not used · cached result';
  else if (run.provider === 'gemini_nano') reasoningStatus = 'Managed by Chrome';
  else if (run.reasoningEffort) {
    reasoningStatus = `${run.reasoningEffort[0].toUpperCase()}${run.reasoningEffort.slice(1)}`;
  }
  diagReasoning.textContent = reasoningStatus;
  diagReasoningTokens.textContent = (inferredOffline && !didModelWork) || cachedWithoutModelWork
    ? 'Not used'
    : Number.isFinite(run.reasoningTokens)
      ? String(run.reasoningTokens)
      : sharedCloudResult ? 'No new request tokens' : 'Not reported';
}

/** Lifetime provider totals, including requests that finish after a cleanup. */
async function loadProviderUsage() {
  const fields = [usageRequests, usageTokens, usageCache, usageProviders, usageReasoning, usageCoverage];
  if (!usageRequests) return;
  try {
    const summary = await readProviderUsageSummary();
    const count = value => Math.max(0, Number(value) || 0).toLocaleString();
    usageRequests.textContent = count(summary.calls);
    usageTokens.textContent = `${count(summary.promptTokens)} in · ${count(summary.completionTokens)} out · ${count(summary.totalTokens)} total`;
    usageCache.textContent = `${count(summary.cachedTokens)} read · ${count(summary.cacheWriteTokens)} written`;
    usageReasoning.textContent = count(summary.reasoningTokens);
    usageProviders.textContent = Object.entries(summary.byProvider || {})
      .filter(([, usage]) => Number(usage.calls) > 0)
      .map(([provider, usage]) => `${PROVIDER_CATALOG[provider]?.name || 'Other provider'}: ${count(usage.calls)}`)
      .join(' · ') || 'No requests recorded';
    const unknown = Number(summary.unknownUsageCalls) || 0;
    usageCoverage.textContent = unknown > 0
      ? `${count(unknown)} request${unknown === 1 ? '' : 's'} without token usage`
      : summary.calls > 0 ? 'Token usage reported for all requests' : 'No requests recorded';
  } catch {
    fields.forEach(field => { field.textContent = 'Unavailable'; });
  }
}

btnClearDiagnostics.addEventListener('click', async () => {
  if (!confirm('Clear Foldnex run history?')) return;
  await chrome.storage.local.remove(['foldnex_last_run', 'foldnex_run_history_v1']);
  await loadRunDiagnostics();
  showToast('Run history cleared.');
});

btnClearProviderUsage.addEventListener('click', async () => {
  if (!confirm('Clear recorded provider request usage?')) return;
  await clearProviderUsage();
  await loadProviderUsage();
  showToast('Provider request usage cleared.');
});

/**
 * Toggle password field visibility
 */
function setupPasswordToggle(btn, input) {
  btn.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    const isHidden = input.type === 'password';
    const icon = btn.querySelector('.material-symbols-rounded');
    if (icon) icon.textContent = isHidden ? 'visibility' : 'visibility_off';
    btn.setAttribute('aria-label', `${isHidden ? 'Show' : 'Hide'} API key`);
    btn.title = `${isHidden ? 'Show' : 'Hide'} API key`;
  });
}
setupPasswordToggle(btnToggleGeminiKey, geminiApiKey);
setupPasswordToggle(btnToggleCompatibleKey, compatibleApiKey);

btnRefreshGeminiModels.addEventListener('click', () => {
  refreshModelCatalog('gemini_api');
});

btnRefreshCompatibleModels.addEventListener('click', () => {
  refreshModelCatalog(selectedCompatibleProvider);
});

/**
 * Keep provider errors actionable without displaying provider response
 * bodies, which can echo request content.
 */
function connectionErrorMessage(error, operation = 'Grouping test') {
  const message = String(error?.message || '');
  if (/Enter.*API key/i.test(message)) return 'Enter an API key to load provider models.';
  if (/HTTP 401|API key is not configured/i.test(message)) return 'Invalid API key. Check the saved key.';
  if (/HTTP 429|quota/i.test(message)) return 'Provider quota or rate limit reached.';
  if (/HTTP 403/i.test(message)) return 'This account cannot access the selected model.';
  if (/HTTP 404/i.test(message)) return 'Model not found. Check the model name.';
  if (/timed out|abort/i.test(message)) return 'Provider timed out. Try again later.';
  const status = message.match(/HTTP (\d{3})/i)?.[1];
  return status ? `Provider returned HTTP ${status}.` : `${operation} failed. Check the model and provider status.`;
}

const CONNECTION_TEST_TABS = [
  { id: 1, title: 'Project plan', url: 'https://example.com/planning' },
  { id: 2, title: 'Project notes', url: 'https://example.com/notes' }
];

/** Label the two synthetic tabs; the test passes when at least one label comes back. */
async function runConnectionTest(settings) {
  const { labels } = await labelTabsWithAI(CONNECTION_TEST_TABS, settings);
  if (!labels || labels.size === 0) throw new Error('The provider returned no usable labels');
}

/**
 * Save Gemini Settings securely to storage.local
 */
btnSaveGemini.addEventListener('click', async () => {
  const key = geminiApiKey.value.trim();
  const model = geminiModel.value.trim() || PROVIDER_CATALOG.gemini_api.defaultModel;
  const reasoning = getReasoningEffortOptions('gemini_api', model).length
    ? { geminiReasoningEffort: geminiReasoningEffort.value }
    : {};

  await saveProviderSecrets({ geminiApiKey: key });
  await chrome.storage.sync.set({ geminiModel: model, ...reasoning });

  if (pendingCloudProvider === 'gemini_api' && key) {
    await activatePendingProvider('gemini_api');
    showToast('Google Gemini saved and selected.');
  } else {
    showToast('Gemini settings saved successfully!');
  }
  await refreshModelCatalog('gemini_api');
});

/**
 * Test the actual grouping request with two synthetic tabs.
 */
btnTestGemini.addEventListener('click', async () => {
  const key = geminiApiKey.value.trim();
  if (!key) {
    showToast('Please enter a Gemini API key first.', 'error');
    return;
  }
  const selectedModel = geminiModel.value.trim() || PROVIDER_CATALOG.gemini_api.defaultModel;
  const reasoning = geminiReasoningEffort.value;
  const context = catalogContext('gemini_api');
  const revision = ++connectionRevisions.gemini;
  const isCurrent = () => revision === connectionRevisions.gemini && catalogContextCurrent(context)
    && (geminiModel.value.trim() || PROVIDER_CATALOG.gemini_api.defaultModel) === selectedModel
    && geminiReasoningEffort.value === reasoning;

  btnTestGemini.textContent = 'Testing...';
  btnTestGemini.disabled = true;

  try {
    await runConnectionTest({
      provider: 'gemini_api',
      geminiApiKey: key,
      geminiModel: selectedModel,
      geminiReasoningEffort: reasoning
    });
    if (!isCurrent()) return;
    showToast('Gemini grouping test passed.', 'success');
    await refreshModelCatalog('gemini_api');
  } catch (e) {
    if (isCurrent()) showToast(connectionErrorMessage(e), 'error');
  } finally {
    if (revision === connectionRevisions.gemini && catalogProviderCurrent('gemini_api')) {
      btnTestGemini.textContent = 'Test connection';
      btnTestGemini.disabled = false;
    }
  }
});

/** Save the selected compatible provider without syncing its secret. */
btnSaveCompatible.addEventListener('click', async () => {
  const provider = selectedCompatibleProvider;
  const config = PROVIDER_CATALOG[provider];
  const apiKeyName = providerSettingKey(provider, 'apiKey');
  const modelName = providerSettingKey(provider, 'model');
  const reasoningName = providerSettingKey(provider, 'reasoningEffort');
  const baseUrlName = providerSettingKey(provider, 'baseUrl');
  const model = compatibleModel.value.trim() || config.defaultModel;
  if (provider === 'openai' && isOpenAIResponsesOnlyModel(model)) {
    showToast('Choose an OpenAI Chat Completions model.', 'error');
    return;
  }
  // Freeze the entire selected provider's draft before storage yields; a
  // provider switch must never pair this key with another provider's URL.
  const secrets = {
    [apiKeyName]: compatibleApiKey.value.trim(),
    ...(provider === 'openai' ? { openaiOAuthToken: openaiOAuthToken.value.trim() } : {})
  };
  const preferences = {
    [modelName]: model,
    ...(getReasoningEffortOptions(provider, model).length ? { [reasoningName]: compatibleReasoningEffort.value } : {}),
    [baseUrlName]: compatibleBaseUrl.value.trim() || config.baseUrl
  };
  const hasAuth = Boolean(secrets[apiKeyName] || (provider === 'openai' && secrets.openaiOAuthToken));
  await saveProviderSecrets(secrets);
  await chrome.storage.sync.set(preferences);
  if (pendingCloudProvider === provider && hasAuth) {
    await activatePendingProvider(provider);
    showToast(`${config.name} saved and selected.`);
  } else {
    showToast(`${config.name} settings saved.`);
  }
  await refreshModelCatalog(provider);
});

/** Test the actual grouping request with two synthetic tabs. */
btnTestCompatible.addEventListener('click', async () => {
  const provider = selectedCompatibleProvider;
  const config = PROVIDER_CATALOG[provider];
  const selectedModel = compatibleModel.value.trim() || config.defaultModel;
  if (provider === 'openai' && isOpenAIResponsesOnlyModel(selectedModel)) {
    showToast('Choose an OpenAI Chat Completions model.', 'error');
    return;
  }
  const keyOrToken = compatibleApiKey.value.trim()
    || (provider === 'openai' ? openaiOAuthToken.value.trim() : '');
  if (!keyOrToken && !config.keyOptional) {
    showToast(`Enter a ${config.name} API key first.`, 'error');
    return;
  }
  const context = catalogContext(provider);
  const reasoning = compatibleReasoningEffort.value;
  const priority = prefOpenaiPriority.checked;
  const revision = ++connectionRevisions.compatible;
  const isCurrent = () => revision === connectionRevisions.compatible && catalogContextCurrent(context)
    && (compatibleModel.value.trim() || config.defaultModel) === selectedModel
    && compatibleReasoningEffort.value === reasoning
    && (provider !== 'openai' || prefOpenaiPriority.checked === priority);

  btnTestCompatible.textContent = 'Testing…';
  btnTestCompatible.disabled = true;

  try {
    const base = compatibleBaseUrl.value.trim() || config.baseUrl;
    await runConnectionTest({
      provider,
      [providerSettingKey(provider, 'apiKey')]: keyOrToken,
      [providerSettingKey(provider, 'model')]: selectedModel,
      [providerSettingKey(provider, 'reasoningEffort')]: reasoning,
      [providerSettingKey(provider, 'baseUrl')]: base,
      ...(provider === 'openai' ? { openaiPriority: priority } : {})
    });
    if (!isCurrent()) return;
    showToast(`${config.name} grouping test passed.`, 'success');
    await refreshModelCatalog(provider);
  } catch (e) {
    if (isCurrent()) showToast(connectionErrorMessage(e), 'error');
  } finally {
    if (revision === connectionRevisions.compatible && catalogProviderCurrent(provider)) {
      btnTestCompatible.textContent = 'Test connection';
      btnTestCompatible.disabled = provider === 'openai'
        && isOpenAIResponsesOnlyModel(compatibleModel.value.trim() || config.defaultModel);
    }
  }
});

/**
 * Load and Render Learned Rules
 */
async function loadLearnedRules() {
  cachedRules = await LearningCache.getRules();
  renderRules(cachedRules);
}

/**
 * Safe DOM rendering of rules table (Zero innerHTML, eliminates DOM XSS)
 */
function renderRules(rules) {
  rulesTableBody.innerHTML = '';

  if (!rules || rules.length === 0) {
    noRulesMsg.classList.remove('hidden');
    return;
  }
  noRulesMsg.classList.add('hidden');

  rules.forEach(rule => {
    const tr = document.createElement('tr');

    // Pattern (safe code element)
    const tdPattern = document.createElement('td');
    const codeElem = document.createElement('code');
    codeElem.textContent = String(rule.pattern ?? '');
    tdPattern.appendChild(codeElem);

    // Category
    const tdCategory = document.createElement('td');
    tdCategory.textContent = String(rule.category ?? '');
    tdCategory.style.fontWeight = '600';

    // Color
    const tdColor = document.createElement('td');
    const colorPill = document.createElement('span');
    colorPill.className = 'color-badge';
    colorPill.style.backgroundColor = getChromeColorHex(rule.color);
    tdColor.appendChild(colorPill);
    tdColor.appendChild(document.createTextNode(rule.color || 'blue'));

    // Confidence
    const tdConf = document.createElement('td');
    tdConf.textContent = `${Math.round((rule.confidence ?? 0.8) * 100)}%`;

    // Matches
    const tdMatches = document.createElement('td');
    tdMatches.textContent = String(rule.matchCount ?? 1);

    // Action
    const tdAction = document.createElement('td');
    const btnDelete = document.createElement('button');
    btnDelete.className = 'danger-btn small-btn';
    const deleteIcon = document.createElement('span');
    deleteIcon.className = 'material-symbols-rounded';
    deleteIcon.setAttribute('aria-hidden', 'true');
    deleteIcon.textContent = 'delete';
    btnDelete.append(deleteIcon, document.createTextNode('Delete'));
    btnDelete.addEventListener('click', async () => {
      await LearningCache.deleteRule(rule.pattern);
      showToast(`Deleted rule for ${rule.pattern}`);
      await loadLearnedRules();
    });
    tdAction.appendChild(btnDelete);

    tr.appendChild(tdPattern);
    tr.appendChild(tdCategory);
    tr.appendChild(tdColor);
    tr.appendChild(tdConf);
    tr.appendChild(tdMatches);
    tr.appendChild(tdAction);

    rulesTableBody.appendChild(tr);
  });
}

function getChromeColorHex(color) {
  const map = {
    grey: '#9aa0a6',
    blue: '#1a73e8',
    red: '#d93025',
    yellow: '#f9ab00',
    green: '#1e8e3e',
    pink: '#e52592',
    purple: '#9334e6',
    cyan: '#12b5cb',
    orange: '#e8710a'
  };
  return map[color] || '#1a73e8';
}

// Search / Filter rules
searchRulesInput.addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  const filtered = cachedRules.filter(r =>
    r.pattern.toLowerCase().includes(q) || r.category.toLowerCase().includes(q)
  );
  renderRules(filtered);
});

/**
 * Add Manual Rule with strict validation & ReDoS defense
 */
btnAddRule.addEventListener('click', async () => {
  const rawPattern = newRulePattern.value.trim();
  const rawCategory = newRuleCategory.value.trim();
  const color = newRuleColor.value;

  if (!rawPattern || !rawCategory) {
    showToast('Please enter both a URL pattern and a category name.', 'error');
    return;
  }

  // 1. Normalize pattern: strip protocol, www, and trim
  let pattern = rawPattern.toLowerCase().replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  // Collapse repetitive wildcards
  pattern = pattern.replace(/\*{2,}/g, '*');

  // 2. Validate pattern content
  if (!pattern || pattern === '*' || pattern === '/*') {
    showToast('Wildcard-only patterns ("*") are not allowed as they match all URLs.', 'error');
    return;
  }

  if (/\s/.test(pattern)) {
    showToast('URL patterns cannot contain whitespace.', 'error');
    return;
  }

  if (pattern.length < 3 || pattern.length > 200) {
    showToast('Pattern must be between 3 and 200 characters.', 'error');
    return;
  }

  // 3. Test regex validity
  const testRegex = safeGlobToRegExp(pattern);
  if (!testRegex) {
    showToast('Invalid pattern syntax. Please check wildcards.', 'error');
    return;
  }

  // 4. Validate category length
  const category = rawCategory.slice(0, 40);

  // 5. Validate color
  const safeColor = CHROME_GROUP_COLORS.includes(color) ? color : 'blue';

  // 6. Deduplicate case-insensitively
  const rules = await LearningCache.getRules();
  const existing = rules.find(r => r.pattern.toLowerCase() === pattern.toLowerCase());

  if (existing) {
    existing.category = category;
    existing.color = safeColor;
    existing.confidence = 1.0;
    existing.userOverride = true;
    existing.source = 'manual_rule';
    existing.schemaVersion = 2;
    existing.updatedAt = Date.now();
  } else {
    rules.push({
      pattern,
      category,
      color: safeColor,
      confidence: 1.0,
      matchCount: 1,
      userOverride: true,
      source: 'manual_rule',
      schemaVersion: 2,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }

  await chrome.storage.local.set({ [LearningCache.STORAGE_KEY]: rules });
  // Rules apply as locked groups at plan time, so labels stay valid.
  await ExactResultCache.clear();
  newRulePattern.value = '';
  newRuleCategory.value = '';
  showToast(`Rule saved for "${pattern}"!`, 'success');
  await loadLearnedRules();
});

// Clear All Rules
btnClearRules.addEventListener('click', async () => {
  if (confirm('Are you sure you want to clear all learned rules & memory cache?')) {
    await LearningCache.resetRules();
    showToast('All learned rules cleared.');
    await loadLearnedRules();
  }
});

// Export Rules JSON
btnExportRules.addEventListener('click', async () => {
  const rules = await LearningCache.getRules();
  const cleanExport = rules.map(r => ({
    pattern: r.pattern,
    category: r.category,
    color: r.color,
    confidence: r.confidence,
    matchCount: r.matchCount,
    userOverride: r.userOverride,
    source: r.source || 'manual_rule'
  }));
  const blob = new Blob([JSON.stringify(cleanExport, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `foldnex-rules-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Rules exported!');
});

// Import Rules JSON with strict schema validation & ReDoS defense
if (btnImportRules && importFileInput) {
  btnImportRules.addEventListener('click', () => {
    importFileInput.value = '';
    importFileInput.click();
  });

  importFileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 1024 * 1024) {
      showToast('Import failed: File exceeds 1MB limit.', 'error');
      return;
    }

    try {
      const text = await file.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        showToast('Import failed: Invalid JSON syntax.', 'error');
        return;
      }

      if (!Array.isArray(parsed)) {
        showToast('Import failed: JSON root must be an array of rules.', 'error');
        return;
      }

      const currentRules = await LearningCache.getRules();
      const existingRuleMap = new Map(currentRules.map(r => [r.pattern.toLowerCase(), r]));

      let importedCount = 0;
      let skippedCount = 0;

      for (const item of parsed) {
        if (!item || typeof item !== 'object') {
          skippedCount++;
          continue;
        }

        let pattern = typeof item.pattern === 'string' ? item.pattern.trim().toLowerCase() : '';
        pattern = pattern.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\*{2,}/g, '*');
        const category = typeof item.category === 'string' ? item.category.trim().slice(0, 40) : '';

        if (!pattern || pattern === '*' || pattern === '/*' || !category || /\s/.test(pattern)) {
          skippedCount++;
          continue;
        }

        if (!safeGlobToRegExp(pattern)) {
          skippedCount++;
          continue;
        }

        const color = CHROME_GROUP_COLORS.includes(item.color?.toLowerCase()) ? item.color.toLowerCase() : 'blue';
        const confidence = typeof item.confidence === 'number' && item.confidence >= 0 && item.confidence <= 1
          ? item.confidence
          : 1.0;
        const matchCount = Number.isInteger(item.matchCount) && item.matchCount >= 0
          ? Math.min(item.matchCount, 100000)
          : 1;

        existingRuleMap.set(pattern, {
          pattern,
          category,
          color,
          confidence,
          matchCount,
          userOverride: true,
          source: 'manual_rule',
          schemaVersion: 2,
          createdAt: Number.isInteger(item.createdAt) ? item.createdAt : Date.now(),
          updatedAt: Date.now()
        });

        importedCount++;
        if (existingRuleMap.size >= LearningCache.MAX_RULES) {
          showToast(`Rule limit of ${LearningCache.MAX_RULES} reached. Further rules truncated.`, 'warning');
          break;
        }
      }

      const mergedRules = Array.from(existingRuleMap.values());
      await chrome.storage.local.set({ [LearningCache.STORAGE_KEY]: mergedRules });
      await ExactResultCache.clear();
      await loadLearnedRules();
      showToast(`Successfully imported ${importedCount} rules (${skippedCount} skipped).`, 'success');
    } catch (err) {
      showToast(`Import error: ${err.message}`, 'error');
    }
  });
}

// Behavior Toggles
groupingStrategyInputs.forEach(input => {
  input.addEventListener('change', async (e) => {
    if (!e.target.checked) return;
    await chrome.storage.sync.set({ groupingStrategy: e.target.value });
    showToast(e.target.value === 'site'
      ? 'Site-category grouping selected.'
      : 'Task-aware grouping selected.');
  });
});

prefOneClickMode.addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ oneClickIconMode: e.target.checked });
  showToast(e.target.checked ? '1-Click icon mode enabled!' : 'Popup menu mode enabled.');
});

prefOpenaiPriority.addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ openaiPriority: e.target.checked });
  showToast(e.target.checked ? 'Priority processing on.' : 'Priority processing off.');
});

prefCloudEconomy.addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ cloudEconomyMode: e.target.checked });
  showToast(e.target.checked ? 'Cloud economy mode on. Fewer requests with simpler group names.' : 'Cloud economy mode off. Optional group refinement restored.');
});

prefAutoGroup.addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ autoGroupNewTabs: e.target.checked });
  autoGroupOn = e.target.checked;
  renderOnDeviceSettings();
  if (!e.target.checked) showToast('Auto-grouping off.');
  else if (onDeviceProvider(savedProvider)) showToast('New tabs will join matching groups. Background preparation stays active.');
  else showToast('New tabs will join matching groups.');
});

prefBackgroundPrep.addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ backgroundPrep: e.target.checked });
  if (e.target.checked) showToast('Background preparation on.');
  else if (autoGroupOn) showToast('Background preparation off. Auto-group keeps it active while it is on.');
  else showToast('Background preparation off. Tabs are labelled when you clean up.');
});

prefModelUnloadAfter.addEventListener('change', async (e) => {
  const value = MODEL_UNLOAD_VALUES.includes(e.target.value) ? e.target.value : '5m';
  await chrome.storage.sync.set({ modelUnloadAfter: value });
  showToast('Unload setting saved.');
});

btnFreeModelMemory.addEventListener('click', async () => {
  btnFreeModelMemory.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'UNLOAD_ON_DEVICE_MODEL' });
    if (!response?.ok) throw new Error('The service worker did not release the model');
    showToast(response.released
      ? 'Model released. Chrome frees its memory within about 5 minutes of last use.'
      : 'The model was not loaded.');
  } catch {
    showToast('Could not release the model. Try again.', 'error');
  } finally {
    btnFreeModelMemory.disabled = false;
    await refreshModelState();
  }
});

prefCollapseGroups.addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ collapseGroupsOnCreation: e.target.checked });
  showToast('Preference saved.');
});

// Reactive Storage Synchronization across windows/popups
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync') {
    if (changes.provider) {
      const newProv = changes.provider.newValue;
      savedProvider = newProv || 'gemini_nano';
      pendingCloudProvider = null;
      renderPendingNote();
      const matchingRadio = document.querySelector(`input[name="providerSelect"][value="${newProv}"]`);
      if (matchingRadio && !matchingRadio.checked) {
        matchingRadio.checked = true;
        updateProviderPanels(newProv);
        collapseProviderPicker(newProv);
      } else {
        renderOnDeviceSettings();
      }
    }
    if (changes.autoGroupNewTabs !== undefined) {
      autoGroupOn = Boolean(changes.autoGroupNewTabs.newValue);
      prefAutoGroup.checked = autoGroupOn;
      renderOnDeviceSettings();
    }
    if (changes.backgroundPrep !== undefined) {
      prefBackgroundPrep.checked = changes.backgroundPrep.newValue === true;
    }
    if (changes.cloudEconomyMode !== undefined) {
      prefCloudEconomy.checked = changes.cloudEconomyMode.newValue === true;
    }
    if (changes.openaiPriority !== undefined) {
      prefOpenaiPriority.checked = changes.openaiPriority.newValue !== false;
    }
    if (changes.modelUnloadAfter !== undefined) {
      const value = changes.modelUnloadAfter.newValue;
      prefModelUnloadAfter.value = MODEL_UNLOAD_VALUES.includes(value) ? value : '5m';
    }
    if (changes[OLLAMA_BASE_URL_KEY] !== undefined) {
      savedOllamaBaseUrl = changes[OLLAMA_BASE_URL_KEY].newValue || '';
      renderOnDeviceSettings();
    }
    if (changes.groupingStrategy) {
      const strategy = changes.groupingStrategy.newValue === 'site' ? 'site' : 'task';
      const strategyInput = document.querySelector(`input[name="groupingStrategy"][value="${strategy}"]`);
      if (strategyInput) strategyInput.checked = true;
    }
    if (changes.oneClickIconMode !== undefined) {
      prefOneClickMode.checked = Boolean(changes.oneClickIconMode.newValue);
    }
    if (changes.collapseGroupsOnCreation !== undefined) {
      prefCollapseGroups.checked = Boolean(changes.collapseGroupsOnCreation.newValue);
    }
  }
  if (areaName === 'local') {
    if (changes[LearningCache.STORAGE_KEY]) loadLearnedRules();
    if (changes.foldnex_last_run) loadRunDiagnostics();
    if (changes[PROVIDER_USAGE_KEY]) loadProviderUsage();
  }
  });
}

/**
 * Settings opened at #engine (from the popup's first-run card): show the
 * engine section. After a Cloud choice without a key, preselect OpenAI
 * without switching to it until a key is saved.
 */
async function openEngineSection() {
  if (location.hash !== '#engine') return;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  activateSettingsTab(document.getElementById('nav-providers'));
  const { provider, setupChoice } = await chrome.storage.sync.get(['provider', 'setupChoice']);
  const current = provider || 'gemini_nano';
  if (setupChoice === 'cloud' && !isCloudProvider(current)) {
    pendingCloudProvider = 'openai';
    const radio = document.querySelector('input[name="providerSelect"][value="openai"]');
    if (radio) radio.checked = true;
    updateProviderPanels('openai');
    renderPendingNote();
    await collapseProviderPicker('openai', { focusDetails: true });
  } else {
    await collapseProviderPicker(current, { focusDetails: true });
  }
}
window.addEventListener('hashchange', () => {
  openEngineSection().catch(error => console.warn('[Foldnex] Could not open the engine section.', error));
});

// Initial boot
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadSettings();
  } catch (error) {
    console.warn('[Foldnex] Settings could not be loaded; keeping the engine chooser available.', error);
    const firstRadio = getProviderRadios()[0];
    if (firstRadio) firstRadio.checked = true;
    syncProviderSelector(firstRadio?.value || 'gemini_nano');
    providerPicker.classList.add('is-ready');
    await expandProviderPicker();
    return;
  }
  await openEngineSection().catch(error => console.warn('[Foldnex] Could not open the engine section.', error));
});
