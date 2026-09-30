import assert from 'node:assert/strict';
import test from 'node:test';

let moduleNumber = 0;
const freshState = () => import(`../src/group-state.js?group-state-test=${++moduleNumber}`);

function installStorage() {
  const stores = { local: {}, session: {}, sync: {} };
  const calls = { get: [], set: [], remove: [] };
  const makeArea = (area, store) => ({
    async get(keys) {
      calls.get.push({ area, keys });
      const list = Array.isArray(keys) ? keys : [keys];
      return structuredClone(Object.fromEntries(list.filter(key => key in store).map(key => [key, store[key]])));
    },
    async set(values) {
      calls.set.push({ area, values: structuredClone(values) });
      Object.assign(store, structuredClone(values));
    },
    async remove(keys) {
      calls.remove.push({ area, keys });
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    }
  });
  globalThis.chrome = { storage: Object.fromEntries(Object.entries(stores).map(([area, store]) => [area, makeArea(area, store)])) };
  return { ...stores, calls };
}

test('private programmatic updates and renamed baselines stay in module memory', async () => {
  const { local, session, sync, calls } = installStorage();
  const state = await freshState();
  await state.markProgrammaticGroupUpdate(71, 'Private research', { incognito: true });
  assert.equal(await state.getGroupTitleBaseline(71), 'Private research');
  assert.equal(await state.consumeProgrammaticGroupUpdate({ id: 71, title: 'Private research' }), true);
  assert.equal(await state.consumeProgrammaticGroupUpdate({ id: 71, title: 'Private research' }), false);
  await state.setGroupTitleBaseline(71, 'Private user rename');
  assert.equal(await state.getGroupTitleBaseline(71), 'Private user rename');
  assert.deepEqual({ local, session, sync }, { local: {}, session: {}, sync: {} });
  assert.deepEqual(calls.get, [], 'private lookups never read shared title bookkeeping');
  assert.deepEqual(calls.set, [], 'no private title or update record is written to any storage area');
  assert.equal(calls.remove.length, 1, 'first recognition only removes legacy session remnants');
  assert.ok(!JSON.stringify(calls).includes('Private'));
});

test('explicit private flags isolate title state across extension page and worker modules', async () => {
  const { session, calls } = installStorage();
  const page = await freshState();
  const worker = await freshState();
  await page.markProgrammaticGroupUpdate(72, 'Page private name', { incognito: true });
  assert.equal(await worker.getGroupTitleBaseline(72, { incognito: true }), undefined);
  assert.equal(await worker.consumeProgrammaticGroupUpdate({ id: 72, title: 'Page private name' }, { incognito: true }), false);
  await worker.setGroupTitleBaseline(72, 'Worker private name', { incognito: true });
  assert.equal(await worker.getGroupTitleBaseline(72), 'Worker private name');
  assert.equal(await page.getGroupTitleBaseline(72), 'Page private name');
  assert.equal(await page.consumeProgrammaticGroupUpdate({ id: 72, title: 'Page private name' }), true);
  assert.deepEqual(session, {});
  assert.deepEqual(calls.get, []);
  assert.deepEqual(calls.set, []);
});

test('ordinary windows retain shared session coordination and adjacent update records', async () => {
  const { local, session, sync, calls } = installStorage();
  const page = await freshState();
  const worker = await freshState();
  await page.markProgrammaticGroupUpdate(81, 'Coding', { incognito: false });
  await page.markProgrammaticGroupUpdate(82, 'Recipes');
  assert.equal(await worker.getGroupTitleBaseline(81), 'Coding');
  assert.equal(await worker.consumeProgrammaticGroupUpdate({ id: 81, title: 'Coding' }), true);
  assert.equal(await worker.consumeProgrammaticGroupUpdate({ id: 81, title: 'Coding' }), false);
  assert.equal(await worker.consumeProgrammaticGroupUpdate({ id: 82, title: 'Recipes' }), true);
  await worker.setGroupTitleBaseline(81, 'Edited by user');
  assert.equal(await page.getGroupTitleBaseline(81), 'Edited by user');
  assert.deepEqual(local, {});
  assert.deepEqual(sync, {});
  assert.equal(session.foldnex_group_title_baseline_81, 'Edited by user');
  assert.ok(calls.set.every(call => call.area === 'session'));
});

test('private expected titles are consumed once on mismatch or expiry', async () => {
  const { calls } = installStorage();
  const state = await freshState();
  await state.markProgrammaticGroupUpdate(73, 'Original private name', { incognito: true });
  assert.equal(await state.consumeProgrammaticGroupUpdate({ id: 73, title: 'Different private name' }), false);
  assert.equal(await state.consumeProgrammaticGroupUpdate({ id: 73, title: 'Original private name' }), false);
  await state.markProgrammaticGroupUpdate(73, 'Expired private name');
  const originalNow = Date.now;
  const future = originalNow() + 61_000;
  try {
    Date.now = () => future;
    assert.equal(await state.consumeProgrammaticGroupUpdate({ id: 73, title: 'Expired private name' }), false);
  } finally {
    Date.now = originalNow;
  }
  assert.equal(await state.consumeProgrammaticGroupUpdate({ id: 73, title: 'Expired private name' }), false);
  assert.deepEqual(calls.set, []);
});

test('seeding resolves TabGroup privacy from its window and removes old private session titles', async () => {
  const { local, session, sync, calls } = installStorage();
  const state = await freshState();
  const windowCalls = [];
  chrome.windows = {
    async get(windowId) { windowCalls.push(windowId); return { id: windowId, incognito: windowId === 2 }; }
  };
  session.foldnex_group_title_baseline_92 = 'Legacy private title';
  session.foldnex_expected_group_update_92 = { title: 'Legacy private title', expiresAt: Date.now() + 60_000 };
  await state.seedGroupTitleBaselines([
    { id: 90, windowId: 1, title: 'Public code' },
    { id: 91, windowId: 1, title: 'Public recipes' },
    { id: 92, windowId: 2, title: 'Private work' },
    { id: 93, windowId: 2, title: 'Private notes', incognito: false },
    { id: 94, windowId: 2, title: '' }
  ]);
  assert.deepEqual(windowCalls, [1, 2], 'each window is resolved once per seed');
  assert.deepEqual(session, { foldnex_group_title_baseline_90: 'Public code', foldnex_group_title_baseline_91: 'Public recipes' });
  assert.equal(await state.getGroupTitleBaseline(92), 'Private work');
  assert.equal(await state.getGroupTitleBaseline(93), 'Private notes');
  await state.setGroupTitleBaseline(94, 'Later private title');
  assert.equal(await state.getGroupTitleBaseline(94), 'Later private title');
  assert.deepEqual(local, {});
  assert.deepEqual(sync, {});
  assert.ok(!JSON.stringify(calls).includes('Private'));
  assert.ok(!JSON.stringify(calls).includes('Legacy private'));
});

test('legacy privacy flags are accepted and unresolved seed privacy is kept in memory', async () => {
  const { session, calls } = installStorage();
  const state = await freshState();
  await state.seedGroupTitleBaselines([
    { id: 95, title: 'Legacy private', incognito: true },
    { id: 96, title: 'Legacy public', incognito: false },
    { id: 97, title: 'Unresolved title' },
    null,
    { id: -1, title: 'Invalid group' }
  ]);
  assert.deepEqual(session, { foldnex_group_title_baseline_96: 'Legacy public' });
  assert.equal(await state.getGroupTitleBaseline(95), 'Legacy private');
  assert.equal(await state.getGroupTitleBaseline(97), 'Unresolved title');
  assert.ok(!JSON.stringify(calls.set).includes('Legacy private'));
  assert.ok(!JSON.stringify(calls.set).includes('Unresolved'));
});

test('member tabs establish seed privacy when the window API is absent', async () => {
  const { session } = installStorage();
  const state = await freshState();
  chrome.tabs = {
    async query({ groupId }) {
      if (groupId === 100) return [{ incognito: true }, { incognito: false }];
      if (groupId === 101) return [{ incognito: false }];
      return [];
    }
  };
  await state.seedGroupTitleBaselines([
    { id: 100, title: 'Private member title' },
    { id: 101, title: 'Public member title' },
    { id: 102, title: 'Unavailable members' }
  ]);
  assert.deepEqual(session, { foldnex_group_title_baseline_101: 'Public member title' });
  assert.equal(await state.getGroupTitleBaseline(100), 'Private member title');
  assert.equal(await state.getGroupTitleBaseline(102), 'Unavailable members');
});

test('privacy lookup failures do not send unresolved names to session storage', async () => {
  const { session, calls } = installStorage();
  const state = await freshState();
  chrome.windows = { get() { throw new Error('Window closed'); } };
  chrome.tabs = { async query() { throw new Error('Group closed'); } };
  await state.seedGroupTitleBaselines([{ id: 103, windowId: 3, title: 'Unresolved private research' }]);
  assert.deepEqual(session, {});
  assert.deepEqual(calls.set, []);
  assert.equal(await state.getGroupTitleBaseline(103), 'Unresolved private research');
});

test('removing a private group clears memory and allows an ID reused by an ordinary group', async () => {
  const { session } = installStorage();
  const state = await freshState();
  await state.markProgrammaticGroupUpdate(104, 'Private title', { incognito: true });
  await state.removeGroupState(104);
  assert.equal(await state.getGroupTitleBaseline(104), undefined);
  assert.equal(await state.consumeProgrammaticGroupUpdate({ id: 104, title: 'Private title' }), false);
  await state.markProgrammaticGroupUpdate(104, 'Public replacement', { incognito: false });
  assert.equal(session.foldnex_group_title_baseline_104, 'Public replacement');
  assert.equal(await state.consumeProgrammaticGroupUpdate({ id: 104, title: 'Public replacement' }), true);
});
