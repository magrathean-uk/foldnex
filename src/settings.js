/** Shared settings reads, engine-choice writes, atomic legacy credential migration and the moves off Gemini Nano and the label pipeline. */
export const PROVIDER_SECRET_KEYS = Object.freeze([
  'geminiApiKey', 'anthropicApiKey', 'openaiApiKey', 'openaiOAuthToken', 'xaiApiKey',
  'groqApiKey', 'openrouterApiKey', 'deepseekApiKey', 'cerebrasApiKey', 'ollamaApiKey'
]);
const secretKeys = new Set(PROVIDER_SECRET_KEYS);
let writes = Promise.resolve();

function withSecretLock(task) {
  if (globalThis.navigator?.locks?.request) {
    return navigator.locks.request('foldnex-provider-secrets', task);
  }
  const result = writes.then(task);
  writes = result.catch(() => {});
  return result;
}

// Gemini Nano left grouping (Phase 3, D33). A saved Nano engine becomes
// Offline smart mode, its setup choice follows, and the settings and timing
// memory that served only Nano are removed. The move keys on the stored
// values, so once written it finds nothing to do again.
const RETIRED_PROVIDER = 'gemini_nano';
const RETIRED_SETUP_CHOICE = 'nano';
// The per-tab label pipeline left too (Phase 4): its label cache and the
// Cloud economy setting, which only skipped its naming requests, go the same way.
const RETIRED_SYNC_KEYS = Object.freeze(['backgroundPrep', 'cloudEconomyMode']);
const RETIRED_LOCAL_KEYS = Object.freeze(['foldnex_nano_perf_v1', 'foldnex_tab_labels_v1']);

async function retireNano(preferences, localRetired) {
  const update = {};
  if (preferences.provider === RETIRED_PROVIDER) update.provider = 'offline';
  if (preferences.setupChoice === RETIRED_SETUP_CHOICE) update.setupChoice = 'offline';
  const syncRemovals = RETIRED_SYNC_KEYS.filter(key => Object.hasOwn(preferences, key));
  if (Object.keys(update).length) {
    // Re-read just before the write: a choice saved meanwhile is kept.
    // The reread values are returned when they win, including a key removed meanwhile.
    const keys = Object.keys(update);
    const fresh = await chrome.storage.sync.get(keys);
    if (fresh.provider !== RETIRED_PROVIDER) delete update.provider;
    if (fresh.setupChoice !== RETIRED_SETUP_CHOICE) delete update.setupChoice;
    for (const key of keys) {
      if (Object.hasOwn(fresh, key)) preferences[key] = fresh[key]; else delete preferences[key];
    }
    if (Object.keys(update).length) await chrome.storage.sync.set(update);
    Object.assign(preferences, update);
  }
  // Removing retired keys is housekeeping: a failure is retried on the next load
  // and never fails the settings read. Retired keys are never returned.
  for (const key of syncRemovals) delete preferences[key];
  await removeBestEffort(chrome.storage.sync, syncRemovals);
  await removeBestEffort(chrome.storage.local, localRetired);
}

async function removeBestEffort(area, keys) {
  if (!keys.length) return;
  try {
    await area.remove(keys);
  } catch (error) {
    console.warn('[Foldnex] Could not remove retired settings; will retry:', error?.message);
  }
}

async function trustLocalStorage() {
  if (chrome.storage.local.setAccessLevel) {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  }
}

export function loadSettings() {
  return withSecretLock(async () => {
    await trustLocalStorage();
    const [preferences, local] = await Promise.all([
      chrome.storage.sync.get(), chrome.storage.local.get([...PROVIDER_SECRET_KEYS, ...RETIRED_LOCAL_KEYS])
    ]);
    const localRetired = RETIRED_LOCAL_KEYS.filter(key => Object.hasOwn(local, key));
    for (const key of localRetired) delete local[key];
    await retireNano(preferences, localRetired);
    const legacyKeys = PROVIDER_SECRET_KEYS.filter(key => Object.hasOwn(preferences, key));
    const migrated = {};
    for (const key of legacyKeys) {
      // An explicitly cleared local key must never be revived from Sync.
      if (!Object.hasOwn(local, key) && typeof preferences[key] === 'string') {
        migrated[key] = preferences[key];
      }
    }
    if (Object.keys(migrated).length) {
      await chrome.storage.local.set(migrated);
      Object.assign(local, migrated);
    }
    // Remove only after successful local persistence. Failure preserves the source.
    if (legacyKeys.length) await chrome.storage.sync.remove(legacyKeys);
    for (const key of PROVIDER_SECRET_KEYS) delete preferences[key];
    return { ...preferences, ...local };
  });
}

/**
 * Save `provider` and `setupChoice` (with any keys written alongside them)
 * under the settings lock the Nano move holds, so neither overwrites the other.
 * With `ifUnset`, write only when no engine is saved yet (the install default);
 * resolves to whether it wrote.
 */
export function saveEngineChoice(values, { ifUnset = false } = {}) {
  return withSecretLock(async () => {
    if (ifUnset) {
      const { provider } = await chrome.storage.sync.get(['provider']);
      if (provider) return false;
    }
    await chrome.storage.sync.set(values);
    return true;
  });
}

export function saveProviderSecrets(values) {
  const secrets = Object.fromEntries(Object.entries(values || {})
    .filter(([key, value]) => secretKeys.has(key) && typeof value === 'string'));
  return withSecretLock(async () => {
    if (!Object.keys(secrets).length) return;
    await trustLocalStorage();
    await chrome.storage.local.set(secrets);
    await chrome.storage.sync.remove(Object.keys(secrets));
  });
}
