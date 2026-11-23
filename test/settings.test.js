import assert from 'node:assert/strict';
import test from 'node:test';

let instance = 0;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function sharedLocks() {
  const queues = new Map();
  return {
    request(name, task) {
      const result = (queues.get(name) || Promise.resolve()).then(task);
      queues.set(name, result.catch(() => {}));
      return result;
    }
  };
}

async function settingsHarness(t, { sync = {}, local = {}, trusted = true, locks = false } = {}) {
  const originalChrome = globalThis.chrome;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => {
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete globalThis.navigator;
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: locks ? { locks: sharedLocks() } : {} });
  const writes = [];
  const state = { sync: structuredClone(sync), local: structuredClone(local), localSetHook: null };
  const makeArea = (name, store) => ({
    async get(keys) {
      if (keys === undefined) return structuredClone(store);
      const requested = Array.isArray(keys) ? keys : [keys];
      return structuredClone(Object.fromEntries(requested.filter(key => Object.hasOwn(store, key)).map(key => [key, store[key]])));
    },
    async set(values) {
      writes.push({ area: name, type: 'set', values: structuredClone(values) });
      if (name === 'local') await state.localSetHook?.(values);
      Object.assign(store, structuredClone(values));
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      writes.push({ area: name, type: 'remove', keys: [...list] });
      list.forEach(key => { delete store[key]; });
    }
  });
  const localArea = makeArea('local', state.local);
  if (trusted) localArea.setAccessLevel = async values => writes.push({ area: 'local', type: 'access', ...values });
  globalThis.chrome = { storage: { sync: makeArea('sync', state.sync), local: localArea } };
  return { ...state, state, writes, module: await import(`../src/settings.js?settings-test=${++instance}`) };
}

test('automatic migration preserves current and explicitly empty local credentials and moves only secret fields', async t => {
  const { state, writes, module } = await settingsHarness(t, {
    sync: {
      provider: 'openai', collapseGroupsOnCreation: true, groupingStrategy: 'task',
      openaiApiKey: 'synthetic-legacy-openai', openaiOAuthToken: 'synthetic-old-token', geminiApiKey: 'synthetic-gemini',
      unrelatedToken: 'ordinary-preference', diagnostics: { enabled: true }
    },
    local: { openaiApiKey: 'synthetic-current-openai', openaiOAuthToken: '', unrelatedLocal: 'keep-local' }
  });
  const settings = await module.loadSettings();
  assert.equal(settings.openaiApiKey, 'synthetic-current-openai');
  assert.equal(settings.openaiOAuthToken, '', 'explicitly cleared credentials must not revive from Sync');
  assert.equal(settings.geminiApiKey, 'synthetic-gemini');
  assert.equal(settings.provider, 'openai');
  assert.equal(settings.collapseGroupsOnCreation, true);
  assert.equal(settings.unrelatedLocal, undefined, 'only local provider credentials overlay preferences');
  assert.deepEqual(state.sync, {
    provider: 'openai', collapseGroupsOnCreation: true, groupingStrategy: 'task', unrelatedToken: 'ordinary-preference', diagnostics: { enabled: true }
  });
  assert.deepEqual(writes.filter(write => write.type === 'set'), [
    { area: 'local', type: 'set', values: { geminiApiKey: 'synthetic-gemini' } }
  ]);
  assert.deepEqual(writes.map(write => write.type), ['access', 'set', 'remove']);
  assert.equal(writes[0].accessLevel, 'TRUSTED_CONTEXTS');
  assert.equal(state.local.unrelatedLocal, 'keep-local');
  assert.equal(Object.hasOwn(state.local, 'unrelatedToken'), false);
});

test('failed local migration preserves the Sync source and a later attempt can recover', async t => {
  const { state, writes, module } = await settingsHarness(t, { sync: { openaiApiKey: 'synthetic-legacy-key', provider: 'openai' } });
  state.localSetHook = async () => { throw new Error('Synthetic local storage failure'); };
  await assert.rejects(module.loadSettings(), /Synthetic local storage failure/);
  assert.equal(state.sync.openaiApiKey, 'synthetic-legacy-key');
  assert.equal(Object.hasOwn(state.local, 'openaiApiKey'), false);
  assert.equal(writes.some(write => write.type === 'remove'), false);
  state.localSetHook = null;
  assert.equal((await module.loadSettings()).openaiApiKey, 'synthetic-legacy-key');
  assert.equal(Object.hasOwn(state.sync, 'openaiApiKey'), false);
});

test('existing local credentials are restricted to trusted contexts even without a legacy migration', async t => {
  const { module, writes } = await settingsHarness(t, { local: { openaiApiKey: 'synthetic-current-key' } });
  assert.equal((await module.loadSettings()).openaiApiKey, 'synthetic-current-key');
  assert.deepEqual(writes, [{ area: 'local', type: 'access', accessLevel: 'TRUSTED_CONTEXTS' }]);
});

for (const useLocks of [false, true]) {
  test(`a new credential save survives concurrent legacy migration (${useLocks ? 'shared Web Lock' : 'fallback queue'})`, async t => {
    const { state, module } = await settingsHarness(t, {
      sync: { openaiApiKey: 'synthetic-legacy-key', provider: 'openai' }, locks: useLocks
    });
    const reachedWrite = deferred();
    const releaseWrite = deferred();
    state.localSetHook = async values => {
      if (values.openaiApiKey === 'synthetic-legacy-key') {
        reachedWrite.resolve();
        await releaseWrite.promise;
      }
    };
    const migration = module.loadSettings();
    await reachedWrite.promise;
    // Separate modules mimic settings and service worker contexts when Web Locks exist.
    const savingContext = useLocks ? await import(`../src/settings.js?settings-test=${++instance}`) : module;
    const save = savingContext.saveProviderSecrets({ openaiApiKey: 'synthetic-new-key' });
    releaseWrite.resolve();
    await Promise.all([migration, save]);
    assert.equal(state.local.openaiApiKey, 'synthetic-new-key');
    assert.equal(Object.hasOwn(state.sync, 'openaiApiKey'), false);
    assert.equal((await module.loadSettings()).openaiApiKey, 'synthetic-new-key');
  });
}

test('secret saves accept explicit clears, ignore other fields and work without the access-level API', async t => {
  const { state, writes, module } = await settingsHarness(t, {
    trusted: false,
    sync: { openaiApiKey: 'synthetic-old-key', provider: 'openai', otherToken: 'keep-sync' },
    local: { openaiApiKey: 'synthetic-current-key' }
  });
  await module.saveProviderSecrets({ openaiApiKey: '', openaiOAuthToken: 'synthetic-token', provider: 'offline', otherToken: 'discard', groqApiKey: 42 });
  assert.deepEqual(state.local, { openaiApiKey: '', openaiOAuthToken: 'synthetic-token' });
  assert.deepEqual(state.sync, { provider: 'openai', otherToken: 'keep-sync' });
  assert.equal(writes.some(write => write.type === 'access'), false);
  const settings = await module.loadSettings();
  assert.equal(settings.openaiApiKey, '');
});

test('a saved Gemini Nano profile moves to Offline smart mode once, with its setup choice, and keeps every secret', async t => {
  const { state, writes, module } = await settingsHarness(t, {
    sync: { provider: 'gemini_nano', setupChoice: 'nano', backgroundPrep: true, modelUnloadAfter: '15m', groupingStrategy: 'task' },
    local: { openaiApiKey: 'synthetic-openai', geminiApiKey: 'synthetic-gemini', foldnex_nano_perf_v1: { overheadMs: 900, msPerTab: 200 }, unrelatedLocal: 'keep' }
  });
  const settings = await module.loadSettings();
  assert.equal(settings.provider, 'offline');
  assert.equal(settings.setupChoice, 'offline');
  assert.equal(Object.hasOwn(settings, 'backgroundPrep'), false);
  assert.equal(settings.openaiApiKey, 'synthetic-openai');
  assert.deepEqual(state.sync, { provider: 'offline', setupChoice: 'offline', modelUnloadAfter: '15m', groupingStrategy: 'task' });
  assert.deepEqual(state.local, { openaiApiKey: 'synthetic-openai', geminiApiKey: 'synthetic-gemini', unrelatedLocal: 'keep' });
  assert.equal(writes.some(write => write.area === 'local' && write.type === 'set'), false, 'secrets are never rewritten');
  assert.equal(writes.some(write => write.type === 'remove' && write.keys.some(key => module.PROVIDER_SECRET_KEYS.includes(key))), false);

  const before = writes.length;
  const again = await module.loadSettings();
  assert.equal(again.provider, 'offline');
  assert.deepEqual(writes.slice(before).map(write => write.type), ['access'], 'a migrated profile is not migrated again');
});

test('the setup choice of an Ollama kept on this device follows Nano to offline, and the engine stays', async t => {
  const { state, module } = await settingsHarness(t, { sync: { provider: 'ollama', setupChoice: 'nano' } });
  const settings = await module.loadSettings();
  assert.equal(settings.provider, 'ollama');
  assert.equal(settings.setupChoice, 'offline');
  assert.deepEqual(state.sync, { provider: 'ollama', setupChoice: 'offline' });
});

for (const useLocks of [false, true]) {
  test(`two surfaces loading a Nano profile at once migrate it once (${useLocks ? 'shared Web Lock' : 'fallback queue'})`, async t => {
    const { state, writes, module } = await settingsHarness(t, {
      sync: { provider: 'gemini_nano', setupChoice: 'nano' }, local: { openaiApiKey: 'synthetic-key' }, locks: useLocks
    });
    const other = useLocks ? await import(`../src/settings.js?settings-test=${++instance}`) : module;
    const [first, second] = await Promise.all([module.loadSettings(), other.loadSettings()]);
    assert.equal(first.provider, 'offline');
    assert.equal(second.provider, 'offline');
    assert.equal(second.setupChoice, 'offline');
    assert.deepEqual(state.sync, { provider: 'offline', setupChoice: 'offline' });
    assert.equal(state.local.openaiApiKey, 'synthetic-key');
    assert.equal(writes.filter(write => write.area === 'sync' && write.type === 'set').length, 1);
  });
}

/** Hold the Nth full or keyed Sync read until released, as the review's probe does. */
function holdSyncRead(state, nth) {
  const entered = deferred();
  const release = deferred();
  const sync = globalThis.chrome.storage.sync;
  const get = sync.get.bind(sync);
  let reads = 0;
  sync.get = async keys => {
    const snapshot = await get(keys);
    if (++reads === nth) {
      entered.resolve();
      await release.promise;
    }
    return snapshot;
  };
  return { entered: entered.promise, release: release.resolve };
}

test('an engine choice saved while the Nano move rereads waits for the settings lock and is kept', async t => {
  const { state, module } = await settingsHarness(t, {
    sync: { provider: 'gemini_nano', setupChoice: 'nano' }, locks: true
  });
  const held = holdSyncRead(state, 2);
  const loading = module.loadSettings();
  await held.entered;
  assert.equal(typeof module.saveEngineChoice, 'function');
  const saving = module.saveEngineChoice({ provider: 'openai', setupChoice: 'cloud' });
  held.release();
  const loaded = await loading;
  await saving;
  assert.deepEqual([state.sync.provider, state.sync.setupChoice], ['openai', 'cloud']);
  assert.deepEqual([loaded.provider, loaded.setupChoice], ['offline', 'offline']);
});

test('a choice that arrives before the reread is kept and is what loadSettings returns', async t => {
  const { state, module } = await settingsHarness(t, {
    sync: { provider: 'gemini_nano', setupChoice: 'nano', groupingStrategy: 'task' }
  });
  const held = holdSyncRead(state, 1);
  const loading = module.loadSettings();
  await held.entered;
  // A write from outside this profile's lock, such as Chrome Sync from another device.
  state.sync.provider = 'openai';
  delete state.sync.setupChoice;
  held.release();
  const loaded = await loading;
  assert.deepEqual([state.sync.provider, state.sync.setupChoice], ['openai', undefined]);
  assert.equal(loaded.provider, 'openai');
  assert.equal(Object.hasOwn(loaded, 'setupChoice'), false);
});

test('the install default is written under the lock only when no engine is saved', async t => {
  const { state, module } = await settingsHarness(t, { sync: { provider: 'openai' }, locks: true });
  assert.equal(await module.saveEngineChoice({ provider: 'offline', groupingStrategy: 'task' }, { ifUnset: true }), false);
  assert.deepEqual(state.sync, { provider: 'openai' });
  delete state.sync.provider;
  assert.equal(await module.saveEngineChoice({ provider: 'offline', groupingStrategy: 'task' }, { ifUnset: true }), true);
  assert.deepEqual(state.sync, { provider: 'offline', groupingStrategy: 'task' });
});

test('a failed removal of retired keys never fails the settings read and never returns them', async t => {
  const { state, module } = await settingsHarness(t, {
    sync: { provider: 'gemini_nano', setupChoice: 'nano', backgroundPrep: true, cloudEconomyMode: true, groqApiKey: 'synthetic-legacy-groq' },
    local: { openaiApiKey: 'synthetic-local', foldnex_nano_perf_v1: {}, foldnex_tab_labels_v1: {} }
  });
  const local = globalThis.chrome.storage.local;
  const remove = local.remove.bind(local);
  local.remove = async () => { throw new Error('injected retirement remove error'); };
  const loaded = await module.loadSettings();
  assert.equal(loaded.groqApiKey, 'synthetic-legacy-groq');
  assert.equal(loaded.openaiApiKey, 'synthetic-local');
  for (const key of ['backgroundPrep', 'cloudEconomyMode', 'foldnex_nano_perf_v1', 'foldnex_tab_labels_v1']) {
    assert.equal(Object.hasOwn(loaded, key), false, key);
  }
  assert.equal(Object.hasOwn(state.sync, 'groqApiKey'), false);
  assert.equal(state.local.groqApiKey, 'synthetic-legacy-groq');
  assert.ok(Object.hasOwn(state.local, 'foldnex_tab_labels_v1'));
  local.remove = remove;
  const again = await module.loadSettings();
  assert.equal(Object.hasOwn(again, 'foldnex_tab_labels_v1'), false);
  assert.equal(Object.hasOwn(state.local, 'foldnex_tab_labels_v1'), false);
  assert.equal(Object.hasOwn(state.local, 'foldnex_nano_perf_v1'), false);
});
