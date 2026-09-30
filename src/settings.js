/** Shared settings reads and atomic legacy credential migration. */
export const PROVIDER_SECRET_KEYS = Object.freeze([
  'geminiApiKey', 'openaiApiKey', 'openaiOAuthToken', 'xaiApiKey',
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

async function trustLocalStorage() {
  if (chrome.storage.local.setAccessLevel) {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  }
}

export function loadSettings() {
  return withSecretLock(async () => {
    await trustLocalStorage();
    const [preferences, local] = await Promise.all([
      chrome.storage.sync.get(), chrome.storage.local.get(PROVIDER_SECRET_KEYS)
    ]);
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
