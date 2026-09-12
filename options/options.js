/**
 * Foldnex - Options & Settings Controller
 */

import { LearningCache, safeGlobToRegExp } from '../src/cache-engine.js';
import { checkChromeNanoStatus, CHROME_GROUP_COLORS } from '../src/ai-engine.js';
import { OAuthHelper } from '../src/oauth-helper.js';

// DOM elements - Navigation
const navItems = document.querySelectorAll('.nav-item');
const tabPanels = document.querySelectorAll('.tab-panel');
const toast = document.getElementById('toast');

// Provider elements
const providerRadios = document.querySelectorAll('input[name="providerSelect"]');
const panelNanoDetails = document.getElementById('panel-nano-details');
const panelGeminiDetails = document.getElementById('panel-gemini-details');
const panelOpenaiDetails = document.getElementById('panel-openai-details');
const panelOfflineDetails = document.getElementById('panel-offline-details');

const nanoStatusText = document.getElementById('nanoStatusText');
const nanoBadge = document.getElementById('nanoBadge');
const btnRecheckNano = document.getElementById('btnRecheckNano');

// Gemini fields
const geminiApiKey = document.getElementById('geminiApiKey');
const geminiModel = document.getElementById('geminiModel');
const btnToggleGeminiKey = document.getElementById('btnToggleGeminiKey');
const btnSaveGemini = document.getElementById('btnSaveGemini');
const btnTestGemini = document.getElementById('btnTestGemini');

// OpenAI fields
const openaiApiKey = document.getElementById('openaiApiKey');
const openaiModel = document.getElementById('openaiModel');
const openaiBaseUrl = document.getElementById('openaiBaseUrl');
const openaiOAuthToken = document.getElementById('openaiOAuthToken');
const btnToggleOpenaiKey = document.getElementById('btnToggleOpenaiKey');
const btnSaveOpenAI = document.getElementById('btnSaveOpenAI');
const btnTestOpenAI = document.getElementById('btnTestOpenAI');
const oauthRedirectUri = document.getElementById('oauthRedirectUri');

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

let cachedRules = [];

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

/**
 * Switch provider config panels
 */
function updateProviderPanels(provider) {
  panelNanoDetails.classList.toggle('hidden', provider !== 'gemini_nano');
  panelGeminiDetails.classList.toggle('hidden', provider !== 'gemini_api');
  panelOpenaiDetails.classList.toggle('hidden', provider !== 'openai');
  panelOfflineDetails.classList.toggle('hidden', provider !== 'offline');
}

providerRadios.forEach(radio => {
  radio.addEventListener('change', async (e) => {
    const provider = e.target.value;
    updateProviderPanels(provider);
    await chrome.storage.sync.set({ provider });
    showToast(`Active AI engine changed to ${provider.replace('_', ' ').toUpperCase()}`);
  });
});

/**
 * Check and refresh Gemini Nano diagnostic status (safe DOM updates, no innerHTML)
 */
async function refreshNanoDiagnostics() {
  nanoStatusText.textContent = 'Detecting Chrome Prompt API & Gemini Nano...';
  nanoBadge.className = 'status-pill checking';
  nanoBadge.textContent = 'Checking...';

  const status = await checkChromeNanoStatus();
  nanoStatusText.textContent = '';

  if (status.status === 'ready') {
    nanoBadge.className = 'status-pill ready';
    nanoBadge.textContent = 'Ready';
    const strong = document.createElement('strong');
    strong.textContent = 'Chrome Gemini Nano is ready! ';
    nanoStatusText.append('✅ ', strong, 'Foldnex can cluster your tabs locally on-device without any API keys or network latency.');
  } else if (status.status === 'downloadable' || status.status === 'downloading') {
    nanoBadge.className = 'status-pill checking';
    nanoBadge.textContent = 'Downloading';
    const strong = document.createElement('strong');
    strong.textContent = String(status.detail ?? '') + '. ';
    nanoStatusText.append('⏳ ', strong, 'Chrome is preparing the on-device model. Open chrome://components and check "Optimization Guide On Device Model".');
  } else {
    nanoBadge.className = 'status-pill checking';
    nanoBadge.textContent = 'Not Active';
    const strong = document.createElement('strong');
    strong.textContent = String(status.detail ?? '') + '. ';
    nanoStatusText.append('⚠️ ', strong, 'Follow the setup steps below to enable Gemini Nano, or configure a Gemini Flash / OpenAI API key as fallback.');
  }
}

btnRecheckNano.addEventListener('click', refreshNanoDiagnostics);

/**
 * Load initial settings (securely loading keys from storage.local with sync fallback)
 */
async function loadSettings() {
  const syncData = await chrome.storage.sync.get([
    'provider',
    'geminiModel',
    'openaiModel',
    'openaiBaseUrl',
    'oneClickIconMode',
    'collapseGroupsOnCreation',
    'geminiApiKey', // check for legacy migration
    'openaiApiKey',
    'openaiOAuthToken'
  ]);

  const localData = await chrome.storage.local.get([
    'geminiApiKey',
    'openaiApiKey',
    'openaiOAuthToken'
  ]);

  const currentProvider = syncData.provider || 'gemini_nano';
  const matchingRadio = document.querySelector(`input[name="providerSelect"][value="${currentProvider}"]`);
  if (matchingRadio) matchingRadio.checked = true;
  updateProviderPanels(currentProvider);

  // Securely prefer local storage for keys
  const geminiKey = localData.geminiApiKey || syncData.geminiApiKey || '';
  const openAIKey = localData.openaiApiKey || syncData.openaiApiKey || '';
  const openAIToken = localData.openaiOAuthToken || syncData.openaiOAuthToken || '';

  if (geminiKey) geminiApiKey.value = geminiKey;
  if (syncData.geminiModel) geminiModel.value = syncData.geminiModel;

  if (openAIKey) openaiApiKey.value = openAIKey;
  if (syncData.openaiModel) openaiModel.value = syncData.openaiModel;
  if (syncData.openaiBaseUrl) openaiBaseUrl.value = syncData.openaiBaseUrl;
  if (openAIToken) openaiOAuthToken.value = openAIToken;

  prefOneClickMode.checked = Boolean(syncData.oneClickIconMode);
  prefCollapseGroups.checked = Boolean(syncData.collapseGroupsOnCreation);

  // Set OAuth redirect URI display
  try {
    oauthRedirectUri.textContent = OAuthHelper.getRedirectUri();
  } catch {
    oauthRedirectUri.textContent = 'chrome://extensions';
  }

  await refreshNanoDiagnostics();
  await loadLearnedRules();
}

/**
 * Toggle password field visibility
 */
function setupPasswordToggle(btn, input) {
  btn.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
  });
}
setupPasswordToggle(btnToggleGeminiKey, geminiApiKey);
setupPasswordToggle(btnToggleOpenaiKey, openaiApiKey);

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
  const model = geminiModel.value;

  await chrome.storage.local.set({ geminiApiKey: key });
  await chrome.storage.sync.set({ geminiModel: model });
  // Clean up from sync if it was previously stored there
  await chrome.storage.sync.remove('geminiApiKey');

  showToast('Gemini settings saved successfully!');
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
      showToast('✅ Gemini API connected successfully!', 'success');
    } else {
      const errMsg = await formatApiErrorMessage(res);
      showToast(`❌ ${errMsg}`, 'error');
    }
  } catch (e) {
    showToast(`Error: ${e.message}`, 'error');
  } finally {
    btnTestGemini.textContent = 'Test Connection';
    btnTestGemini.disabled = false;
  }
});

/**
 * Save OpenAI Settings securely to storage.local
 */
btnSaveOpenAI.addEventListener('click', async () => {
  const key = openaiApiKey.value.trim();
  const token = openaiOAuthToken.value.trim();

  await chrome.storage.local.set({
    openaiApiKey: key,
    openaiOAuthToken: token
  });
  await chrome.storage.sync.set({
    openaiModel: openaiModel.value.trim() || 'gpt-4o-mini',
    openaiBaseUrl: openaiBaseUrl.value.trim() || 'https://api.openai.com/v1'
  });
  // Clean up from sync if previously stored there
  await chrome.storage.sync.remove(['openaiApiKey', 'openaiOAuthToken']);

  showToast('OpenAI settings saved successfully!');
});

/**
 * Test OpenAI Connection
 */
btnTestOpenAI.addEventListener('click', async () => {
  const keyOrToken = openaiApiKey.value.trim() || openaiOAuthToken.value.trim();
  if (!keyOrToken) {
    showToast('Please enter an OpenAI API Key or OAuth token first.', 'error');
    return;
  }

  btnTestOpenAI.textContent = 'Testing...';
  btnTestOpenAI.disabled = true;

  try {
    const base = openaiBaseUrl.value.trim() || 'https://api.openai.com/v1';
    const endpoint = `${base.replace(/\/+$/, '')}/chat/completions`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keyOrToken}`
      },
      body: JSON.stringify({
        model: openaiModel.value.trim() || 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Reply "ok"' }],
        max_tokens: 5
      })
    });

    if (res.ok) {
      showToast('✅ OpenAI connected successfully!', 'success');
    } else {
      const errMsg = await formatApiErrorMessage(res);
      showToast(`❌ ${errMsg}`, 'error');
    }
  } catch (e) {
    showToast(`Error: ${e.message}`, 'error');
  } finally {
    btnTestOpenAI.textContent = 'Test Connection';
    btnTestOpenAI.disabled = false;
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
    existing.updatedAt = Date.now();
  } else {
    rules.push({
      pattern,
      category,
      color: safeColor,
      confidence: 1.0,
      matchCount: 1,
      userOverride: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }

  await chrome.storage.local.set({ [LearningCache.STORAGE_KEY]: rules });
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
    userOverride: r.userOverride
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
      await loadLearnedRules();
      showToast(`Successfully imported ${importedCount} rules (${skippedCount} skipped).`, 'success');
    } catch (err) {
      showToast(`Import error: ${err.message}`, 'error');
    }
  });
}

// Behavior Toggles
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
    if (changes.oneClickIconMode !== undefined) {
      prefOneClickMode.checked = Boolean(changes.oneClickIconMode.newValue);
    }
    if (changes.collapseGroupsOnCreation !== undefined) {
      prefCollapseGroups.checked = Boolean(changes.collapseGroupsOnCreation.newValue);
    }
  }
  if (areaName === 'local' && changes[LearningCache.STORAGE_KEY]) {
    loadLearnedRules();
  }
});

// Initial boot
document.addEventListener('DOMContentLoaded', loadSettings);
