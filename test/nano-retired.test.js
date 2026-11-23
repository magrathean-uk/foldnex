// Gemini Nano left grouping (Phase 3): a profile that chose it, or any stale
// engine value, gets the local engine's result with no request of any kind.
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveProvider } from '../src/ai-engine.js';
import { executeTabGrouping } from '../src/grouper.js';

import { installBrowser, makeArea, makeTabs, membership } from './plan-harness.js';

/** Count every provider request and every touch of Chrome's Prompt API. */
function watchRequests() {
  const original = globalThis.fetch;
  const seen = { fetches: [], languageModel: 0 };
  globalThis.fetch = async url => {
    seen.fetches.push(String(url));
    throw new Error('No request may be sent');
  };
  const fake = { availability: async () => 'available', create: async () => ({ prompt: async () => '{}', destroy() {} }) };
  Object.defineProperty(globalThis, 'LanguageModel', {
    configurable: true,
    get() {
      seen.languageModel++;
      return fake;
    }
  });
  return {
    seen,
    restore() {
      globalThis.fetch = original;
      delete globalThis.LanguageModel;
    }
  };
}

async function offlineMembership(windowId, startId) {
  installBrowser(makeTabs(windowId, startId));
  const result = await executeTabGrouping(windowId, { provider: 'offline', groupingStrategy: 'task' });
  return membership(result.groups).map(ids => ids.split(',').map(id => Number(id) - startId).join(','));
}

test('a click on a migrated Nano profile gives the local result with no request and no Prompt API access', async () => {
  const expected = await offlineMembership(601, 60100);
  installBrowser(makeTabs(602, 60200));
  const sync = { provider: 'gemini_nano', setupChoice: 'nano', groupingStrategy: 'task', backgroundPrep: true };
  chrome.storage.sync = makeArea(sync);
  const watch = watchRequests();
  try {
    const result = await executeTabGrouping(602, null);
    assert.equal(result.source, 'offline');
    assert.equal(result.provider, 'offline');
    assert.deepEqual(membership(result.groups).map(ids => ids.split(',').map(id => Number(id) - 60200).join(',')), expected);
    assert.deepEqual(watch.seen.fetches, []);
    assert.equal(watch.seen.languageModel, 0);
    assert.equal(sync.provider, 'offline');
    assert.equal(sync.setupChoice, 'offline');
  } finally {
    watch.restore();
  }
});

for (const stale of ['gemini_nano', 'retired_engine', '', undefined, 42]) {
  test(`a stale engine value (${JSON.stringify(stale)}) at runtime falls to the local engine, never to a request`, async () => {
    assert.equal(resolveProvider(stale), 'offline');
    installBrowser(makeTabs(603, 60300));
    const watch = watchRequests();
    try {
      const result = await executeTabGrouping(603, { provider: stale, groupingStrategy: 'task' });
      assert.equal(result.source, 'offline');
      assert.equal(result.fallbackUsed, false);
      assert.deepEqual(watch.seen.fetches, []);
      assert.equal(watch.seen.languageModel, 0);
    } finally {
      watch.restore();
    }
  });
}
