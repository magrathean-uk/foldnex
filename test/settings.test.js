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
      provider: 'openai', cloudEconomyMode: true, groupingStrategy: 'task',
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
  assert.equal(settings.cloudEconomyMode, true);
  assert.equal(settings.unrelatedLocal, undefined, 'only local provider credentials overlay preferences');
  assert.deepEqual(state.sync, {
    provider: 'openai', cloudEconomyMode: true, groupingStrategy: 'task', unrelatedToken: 'ordinary-preference', diagnostics: { enabled: true }
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
