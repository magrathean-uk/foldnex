/**
 * Foldnex - Options & Settings Controller
 */

import { ExactResultCache, LearningCache, safeGlobToRegExp } from '../src/cache-engine.js';
import {
  checkChromeNanoStatus,
  prepareChromeNano,
  CHROME_GROUP_COLORS,
  PROVIDER_CATALOG,
  listProviderModels,
  providerSettingKey
} from '../src/ai-engine.js';

// DOM elements - Navigation
const navItems = document.querySelectorAll('.nav-item');
const tabPanels = document.querySelectorAll('.tab-panel');
const toast = document.getElementById('toast');

// Provider elements
const providerList = document.getElementById('providerList');
const panelNanoDetails = document.getElementById('panel-nano-details');
const panelGeminiDetails = document.getElementById('panel-gemini-details');
const panelCompatibleDetails = document.getElementById('panel-compatible-details');
const panelOfflineDetails = document.getElementById('panel-offline-details');

const nanoStatusText = document.getElementById('nanoStatusText');
const btnRecheckNano = document.getElementById('btnRecheckNano');

// Gemini fields
const geminiApiKey = document.getElementById('geminiApiKey');
const geminiModel = document.getElementById('geminiModel');
const geminiModelOptions = document.getElementById('geminiModelOptions');
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
const compatibleModelOptions = document.getElementById('compatibleModelOptions');
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

let cachedRules = [];
let selectedCompatibleProvider = 'openai';
let lastNanoStatus = 'checking';
const MODEL_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Display toast notification
 */
function showToast(msg, type = 'success') {
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 3500);
}

/**
 * Switch tabs in options layout
 */
navItems.forEach(item => {
  item.addEventListener('click', () => {
    const targetTab = item.dataset.tab;
    navItems.forEach(i => i.classList.remove('active'));
    tabPanels.forEach(p => p.classList.remove('active'));

    item.classList.add('active');
    document.getElementById(`tab-${targetTab}`)?.classList.add('active');
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

function modelCatalogCacheKey(provider) {
  return providerSettingKey(provider, 'modelCatalog');
}

function modelUi(provider) {
  if (provider === 'gemini_api') {
    return {
      input: geminiModel,
      options: geminiModelOptions,
      status: geminiModelsStatus,
      button: btnRefreshGeminiModels
    };
  }
  return {
    input: compatibleModel,
    options: compatibleModelOptions,
    status: compatibleModelsStatus,
    button: btnRefreshCompatibleModels
  };
}

function renderModelOptions(provider, models, fetchedAt = 0) {
  if (provider !== 'gemini_api' && selectedCompatibleProvider !== provider) return;
  const ui = modelUi(provider);
  ui.options.textContent = '';
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model;
    ui.options.append(option);
  }
  const age = fetchedAt ? ` · updated ${new Date(fetchedAt).toLocaleString()}` : '';
  ui.status.textContent = `${models.length} model${models.length === 1 ? '' : 's'} from the provider${age}.`;
}

async function refreshModelCatalog(provider, { force = false } = {}) {
  const config = PROVIDER_CATALOG[provider];
  if (!config || !['gemini', 'compatible'].includes(config.mode)) return;
  if (provider !== 'gemini_api' && selectedCompatibleProvider !== provider) return;

  const ui = modelUi(provider);
  const cacheKey = modelCatalogCacheKey(provider);
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  if (Array.isArray(cached?.models) && cached.models.length) {
    renderModelOptions(provider, cached.models, cached.fetchedAt);
    if (!force && Date.now() - Number(cached.fetchedAt || 0) < MODEL_CACHE_MAX_AGE_MS) return;
  }
  if (provider !== 'gemini_api' && selectedCompatibleProvider !== provider) return;

  const apiKey = provider === 'gemini_api'
    ? geminiApiKey.value.trim()
    : compatibleApiKey.value.trim() || (provider === 'openai' ? openaiOAuthToken.value.trim() : '');
  const baseUrl = provider === 'gemini_api' ? '' : compatibleBaseUrl.value.trim();

  ui.button.disabled = true;
  ui.button.textContent = 'Loading…';
  ui.status.textContent = 'Loading the live model catalog…';
  try {
    const models = await listProviderModels(provider, { apiKey, baseUrl });
    if (!models.length) throw new Error('The provider returned no models');
    const catalog = { models, fetchedAt: Date.now() };
    await chrome.storage.local.set({ [cacheKey]: catalog });
    renderModelOptions(provider, models, catalog.fetchedAt);
  } catch (error) {
    if (provider === 'gemini_api' || selectedCompatibleProvider === provider) {
      ui.status.textContent = error.message;
    }
  } finally {
    if (provider === 'gemini_api' || selectedCompatibleProvider === provider) {
      ui.button.disabled = false;
      ui.button.textContent = 'Refresh models';
    }
  }
}

async function loadCompatibleProvider(provider) {
  const config = PROVIDER_CATALOG[provider];
  if (!config || config.mode !== 'compatible') return;
  selectedCompatibleProvider = provider;

  const [syncData, localData] = await Promise.all([
    chrome.storage.sync.get([
      providerSettingKey(provider, 'model'),
      providerSettingKey(provider, 'baseUrl'),
      providerSettingKey(provider, 'apiKey'),
      'openaiOAuthToken'
    ]),
    chrome.storage.local.get([
      providerSettingKey(provider, 'apiKey'),
      'openaiOAuthToken'
    ])
  ]);

  if (selectedCompatibleProvider !== provider) return;

  compatibleProviderTitle.textContent = `${config.name} configuration`;
  compatibleApiKeyLabel.textContent = config.keyOptional ? 'API key (optional)' : `${config.name} API key`;
  compatibleApiKey.placeholder = config.keyOptional ? 'Optional for this local endpoint' : 'Paste provider key';
  compatibleApiKey.value = localData[providerSettingKey(provider, 'apiKey')]
    || syncData[providerSettingKey(provider, 'apiKey')]
    || '';
  compatibleModel.value = syncData[providerSettingKey(provider, 'model')] || config.defaultModel || '';
  compatibleBaseUrl.value = syncData[providerSettingKey(provider, 'baseUrl')] || config.baseUrl || '';
  oauthSection.classList.toggle('hidden', provider !== 'openai');
  if (provider === 'openai') {
    openaiOAuthToken.value = localData.openaiOAuthToken || syncData.openaiOAuthToken || '';
  }
  compatibleModelOptions.textContent = '';
  compatibleModelsStatus.textContent = 'Loading the provider’s model catalog…';
  await refreshModelCatalog(provider);
}

/** Switch the single details area to the selected engine. */
function updateProviderPanels(provider) {
  const config = PROVIDER_CATALOG[provider];
  panelNanoDetails.classList.toggle('hidden', provider !== 'gemini_nano');
  panelGeminiDetails.classList.toggle('hidden', provider !== 'gemini_api');
  panelCompatibleDetails.classList.toggle('hidden', config?.mode !== 'compatible');
  panelOfflineDetails.classList.toggle('hidden', provider !== 'offline');
  if (provider === 'gemini_nano') refreshNanoDiagnostics();
  if (config?.mode === 'compatible') loadCompatibleProvider(provider);
  if (provider === 'gemini_api') refreshModelCatalog(provider);
}

renderProviderList();
getProviderRadios().forEach(radio => {
  radio.addEventListener('change', async (e) => {
    const provider = e.target.value;
    updateProviderPanels(provider);
    await chrome.storage.sync.set({ provider });
    showToast(`${PROVIDER_CATALOG[provider].name} selected.`);
  });
});

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

  try {
    const status = await checkChromeNanoStatus();
    lastNanoStatus = status.status;
    nanoStatusText.textContent = '';

    if (status.status === 'ready') {
      nanoBadge.className = 'status-pill ready';
      nanoBadge.textContent = 'Ready';
      btnRecheckNano.textContent = 'Check again';
      const strong = document.createElement('strong');
      strong.textContent = 'Local model ready. ';
      nanoStatusText.append(strong, 'Keep the Foldnex popup open while grouping with Nano.');
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
    showToast('Chrome Gemini Nano is ready.');
  } catch (error) {
    showToast(`Local model setup failed: ${error.message}`, 'error');
  } finally {
    await refreshNanoDiagnostics();
  }
});

/**
 * Load initial settings (securely loading keys from storage.local with sync fallback)
 */
async function loadSettings() {
  const syncData = await chrome.storage.sync.get([
    'provider',
    'geminiModel',
    'groupingStrategy',
    'oneClickIconMode',
    'collapseGroupsOnCreation',
    'geminiApiKey'
  ]);

  const localData = await chrome.storage.local.get([
    'geminiApiKey'
  ]);

  const currentProvider = syncData.provider || 'gemini_nano';
  const matchingRadio = document.querySelector(`input[name="providerSelect"][value="${currentProvider}"]`);
  if (matchingRadio) matchingRadio.checked = true;

  // Securely prefer local storage for keys
  const geminiKey = localData.geminiApiKey || syncData.geminiApiKey || '';
  if (geminiKey) geminiApiKey.value = geminiKey;
  geminiModel.value = syncData.geminiModel || PROVIDER_CATALOG.gemini_api.defaultModel;

  updateProviderPanels(currentProvider);

  prefOneClickMode.checked = Boolean(syncData.oneClickIconMode);
  prefCollapseGroups.checked = Boolean(syncData.collapseGroupsOnCreation);
  const strategy = syncData.groupingStrategy === 'site' ? 'site' : 'task';
  const strategyInput = document.querySelector(`input[name="groupingStrategy"][value="${strategy}"]`);
  if (strategyInput) strategyInput.checked = true;

  await loadLearnedRules();
  await loadRunDiagnostics();
}

async function loadRunDiagnostics() {
  if (!diagEngine) return;
  const { foldnex_last_run: run } = await chrome.storage.local.get('foldnex_last_run');
  if (!run) return;

  const providerName = PROVIDER_CATALOG[run.provider]?.name || run.provider || 'Unknown';
  diagEngine.textContent = run.strategy === 'site'
    ? 'Site categories · local'
    : run.model ? `${providerName} · ${run.model}` : providerName;
  diagSource.textContent = String(run.source || 'unknown').replaceAll('-', ' ');
  diagOutcome.textContent = `${run.tabsGrouped || 0} tabs · ${run.groupsCreated || 0} groups · ${run.duplicateTabsClosed || 0} duplicates`;
  diagTokens.textContent = run.promptTokens || run.completionTokens
    ? `${run.promptTokens || 0} in · ${run.completionTokens || 0} out · ${run.cachedTokens || 0} cached`
    : 'Local or cache result';
  diagLatency.textContent = run.latencyMs ? `${run.latencyMs} ms total` : '—';
  diagQuality.textContent = run.qualityFlags?.length ? run.qualityFlags.join(' · ') : 'Passed';
  const diagFallback = document.getElementById('diagFallback');
  if (diagFallback) {
    diagFallback.textContent = run.fallbackDetail || run.fallbackCode || 'None';
  }
}

/**
 * Toggle password field visibility
 */
function setupPasswordToggle(btn, input) {
  btn.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    btn.textContent = input.type === 'password' ? 'Show' : 'Hide';
  });
}
setupPasswordToggle(btnToggleGeminiKey, geminiApiKey);
setupPasswordToggle(btnToggleCompatibleKey, compatibleApiKey);

btnRefreshGeminiModels.addEventListener('click', () => {
  refreshModelCatalog('gemini_api', { force: true });
});

btnRefreshCompatibleModels.addEventListener('click', () => {
  refreshModelCatalog(selectedCompatibleProvider, { force: true });
});

/**
 * Helper to parse and format actionable API test errors
 */
async function formatApiErrorMessage(res) {
  let errorDetail = '';
  try {
    const errorJson = await res.json();
    errorDetail = errorJson?.error?.message || '';
  } catch {
    // Non-JSON response
  }

  if (res.status === 401 || (res.status === 400 && errorDetail.toLowerCase().includes('key'))) {
    return 'Invalid API Key. Please verify your key.';
  }
  if (res.status === 429 || errorDetail.toLowerCase().includes('quota')) {
    return 'Quota exceeded (Rate limit / Plan limit). Check your AI Studio / OpenAI billing.';
  }
  if (res.status === 403) {
    return 'Access forbidden. Your account or region may not have access to this model.';
  }
  if (res.status === 404) {
    return 'Model not found. Please verify the model name.';
  }
  return `Error (HTTP ${res.status}): ${errorDetail || res.statusText || 'Request failed'}`;
}

/**
 * Save Gemini Settings securely to storage.local
 */
btnSaveGemini.addEventListener('click', async () => {
  const key = geminiApiKey.value.trim();
  const model = geminiModel.value.trim() || PROVIDER_CATALOG.gemini_api.defaultModel;

  await chrome.storage.local.set({ geminiApiKey: key });
  await chrome.storage.sync.set({ geminiModel: model });
  // Clean up from sync if it was previously stored there
  await chrome.storage.sync.remove('geminiApiKey');

  showToast('Gemini settings saved successfully!');
  await refreshModelCatalog('gemini_api', { force: true });
});

/**
 * Test Gemini Connection with x-goog-api-key header (no key in query string)
 */
btnTestGemini.addEventListener('click', async () => {
  const key = geminiApiKey.value.trim();
  if (!key) {
    showToast('Please enter a Gemini API key first.', 'error');
    return;
  }

  btnTestGemini.textContent = 'Testing...';
  btnTestGemini.disabled = true;

  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel.value)}:generateContent`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Respond with: {"status":"ok"}' }] }]
      })
    });

    if (res.ok) {
      showToast('Gemini API connected.', 'success');
    } else {
      const errMsg = await formatApiErrorMessage(res);
      showToast(errMsg, 'error');
    }
  } catch (e) {
    showToast(`Error: ${e.message}`, 'error');
  } finally {
    btnTestGemini.textContent = 'Test Connection';
    btnTestGemini.disabled = false;
  }
});

/** Save the selected compatible provider without syncing its secret. */
btnSaveCompatible.addEventListener('click', async () => {
  const provider = selectedCompatibleProvider;
  const config = PROVIDER_CATALOG[provider];
  const apiKeyName = providerSettingKey(provider, 'apiKey');
  const modelName = providerSettingKey(provider, 'model');
  const baseUrlName = providerSettingKey(provider, 'baseUrl');

  await chrome.storage.local.set({
    [apiKeyName]: compatibleApiKey.value.trim(),
    ...(provider === 'openai' ? { openaiOAuthToken: openaiOAuthToken.value.trim() } : {})
  });
  await chrome.storage.sync.set({
    [modelName]: compatibleModel.value.trim() || config.defaultModel,
    [baseUrlName]: compatibleBaseUrl.value.trim() || config.baseUrl
  });
  await chrome.storage.sync.remove([apiKeyName, 'openaiOAuthToken']);
  showToast(`${config.name} settings saved.`);
  await refreshModelCatalog(provider, { force: true });
});

/** Make a minimal live completion request to the selected provider. */
btnTestCompatible.addEventListener('click', async () => {
  const provider = selectedCompatibleProvider;
  const config = PROVIDER_CATALOG[provider];
  const keyOrToken = compatibleApiKey.value.trim()
    || (provider === 'openai' ? openaiOAuthToken.value.trim() : '');
  if (!keyOrToken && !config.keyOptional) {
    showToast(`Enter a ${config.name} API key first.`, 'error');
    return;
  }

  btnTestCompatible.textContent = 'Testing…';
  btnTestCompatible.disabled = true;

  try {
    const base = compatibleBaseUrl.value.trim() || config.baseUrl;
    const headers = { 'Content-Type': 'application/json' };
    if (keyOrToken) headers.Authorization = `Bearer ${keyOrToken}`;
    if (provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/magrathean-uk/foldnex';
      headers['X-Title'] = 'Foldnex';
    }

    const payload = {
      model: compatibleModel.value.trim() || config.defaultModel,
      messages: [{ role: 'user', content: 'Reply with the single word ok.' }],
      temperature: 0
    };
    if (provider === 'openai' || provider === 'groq') payload.max_completion_tokens = 32;
    else payload.max_tokens = 32;

    const res = await fetch(`${base.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      showToast(`${config.name} connected.`, 'success');
    } else {
      showToast(await formatApiErrorMessage(res), 'error');
    }
  } catch (e) {
    showToast(`Connection failed: ${e.message}`, 'error');
  } finally {
    btnTestCompatible.textContent = 'Test connection';
    btnTestCompatible.disabled = false;
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
    btnDelete.textContent = 'Delete';
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

prefCollapseGroups.addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ collapseGroupsOnCreation: e.target.checked });
  showToast('Preference saved.');
});

// Reactive Storage Synchronization across windows/popups
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync') {
    if (changes.provider) {
      const newProv = changes.provider.newValue;
      const matchingRadio = document.querySelector(`input[name="providerSelect"][value="${newProv}"]`);
      if (matchingRadio && !matchingRadio.checked) {
        matchingRadio.checked = true;
        updateProviderPanels(newProv);
      }
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
  }
});

// Initial boot
document.addEventListener('DOMContentLoaded', loadSettings);
