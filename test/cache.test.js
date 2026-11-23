import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import {
  CACHE_SCHEMA,
  ExactResultCache,
  LearningCache,
  MAX_RULE_PATTERN_LENGTH,
  PlanMemory,
  WindowPlanStore,
  fingerprintTab,
  hashToken,
  normalizeUserGroupName,
  readResetEpoch,
  safeGlobToRegExp,
  sanitizeTitle
} from '../src/cache-engine.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOUD_ENGINES = ['openai', 'anthropic', 'gemini', 'groq', 'openrouter'];

/**
 * In-memory chrome.storage with structured-clone semantics. An optional delay
 * makes every get and set yield, so an unserialised read-modify-write loses data.
 * hooks.afterGet(keys) runs after a get has taken its snapshot and
 * hooks.beforeSet(values) before a set applies, so a test can land another
 * context's write in between.
 */
function installChromeStorageMock({ delayMs = 0 } = {}) {
  const local = {};
  const session = {};
  const hooks = { afterGet: null, beforeSet: null };
  const pause = () => (delayMs ? new Promise(resolve => setTimeout(resolve, delayMs)) : Promise.resolve());
  const makeArea = store => ({
    async get(keys) {
      await pause();
      if (keys === undefined || keys === null) return structuredClone(store);
      const list = Array.isArray(keys) ? keys : [keys];
      const snapshot = structuredClone(Object.fromEntries(list.filter(key => key in store).map(key => [key, store[key]])));
      if (hooks.afterGet) await hooks.afterGet(list);
      return snapshot;
    },
    async set(values) {
      await pause();
      if (hooks.beforeSet) await hooks.beforeSet(values);
      Object.assign(store, structuredClone(values));
    },
    async remove(keys) {
      await pause();
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    }
  });
  globalThis.chrome = {
    storage: {
      local: makeArea(local),
      session: makeArea(session)
    }
  };
  return { local, session, hooks };
}

function makeTabs(count, { start = 1, prefix = 'Tab' } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: start + index,
    title: `${prefix} secret title ${start + index}`,
    url: `https://example-${start + index}.test/private/path?q=${start + index}`
  }));
}

test('hashToken is a synchronous 32-bit FNV-1a over UTF-8 as 8 hex characters', () => {
  assert.equal(hashToken(''), '811c9dc5');
  assert.equal(hashToken('a'), 'e40c292c');
  assert.equal(hashToken('japan'), hashToken('japan'));
  assert.notEqual(hashToken('japan'), hashToken('paris'));
  assert.match(hashToken('Küche'), /^[0-9a-f]{8}$/);
  assert.notEqual(hashToken('Küche'), hashToken('Kuche'));
});

test('sanitizeTitle strips the en-dash suffix German Wikipedia uses', () => {
  assert.equal(sanitizeTitle('Bundesrepublik Deutschland – Wikipedia'), 'Bundesrepublik Deutschland');
  assert.equal(sanitizeTitle('Rust programming language - Wikipedia'), 'Rust programming language');
});

test('readResetEpoch returns a numeric generation with zero for an absent or invalid value', async () => {
  const { local } = installChromeStorageMock();
  assert.equal(await readResetEpoch(), 0);
  for (const value of [-1, 1.5, 'invalid', Number.MAX_SAFE_INTEGER + 1]) {
    local.foldnex_reset_epoch = value;
    assert.equal(await readResetEpoch(), 0);
  }
  local.foldnex_reset_epoch = 3;
  assert.equal(await readResetEpoch(), 3);
});

test('wildcard matching stays bounded for a long separated-wildcard non-match', () => {
  // Run the adversarial input in a bounded subprocess: a regression to a
  // backtracking expression must fail the test instead of hanging the suite.
  const moduleUrl = new URL('../src/cache-engine.js', import.meta.url).href;
  const script = `import { safeGlobToRegExp } from ${JSON.stringify(moduleUrl)};
    const matcher = safeGlobToRegExp('example.test/' + 'a*'.repeat(26) + 'b');
    if (matcher.test('example.test/' + 'a'.repeat(6000))) process.exit(1);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 3000 });
  assert.equal(result.error, undefined, 'the non-match must complete within the subprocess deadline');
  assert.equal(result.status, 0, result.stderr?.toString());
});

test('wildcard matcher preserves literal punctuation, case, anchors and consecutive wildcard semantics', () => {
  const literal = 'example.test/a.+?^${}()|[x]\\';
  assert.equal(safeGlobToRegExp(literal).test(literal.toUpperCase()), true);
  assert.equal(safeGlobToRegExp(literal).test('example.test/abx'), false);
  const matcher = safeGlobToRegExp(' EXAMPLE.TEST/A***B*C ');
  assert.equal(matcher.test('example.test/abc'), true, 'wildcards may be empty');
  assert.equal(matcher.test('example.test/alongbmiddlec'), true);
  assert.equal(matcher.test('beforeexample.test/abc'), false);
  assert.equal(matcher.test('example.test/abcafter'), false);
  assert.equal(matcher.test('example.test/a\nbc'), false);
  assert.equal(safeGlobToRegExp('*ab*ab').test('ab'), false, 'literals cannot overlap');
  assert.equal(safeGlobToRegExp('*ab*ab').test('abab'), true);
  assert.equal(safeGlobToRegExp('Σ*').test('ςpath'), true);
  assert.equal(safeGlobToRegExp('k*').test('Kpath'), false);
  assert.equal(safeGlobToRegExp('i*').test('İpath'), false);
});

test('rule validation uses a shared length bound and rejects controls, malformed rules and supplied matchers', async () => {
  const { local } = installChromeStorageMock();
  const valid = { pattern: 'EXAMPLE.TEST/Projects/*', category: 'Projects', confidence: 1, source: 'manual_rule' };
  const longPattern = `example.test/${'x'.repeat(MAX_RULE_PATTERN_LENGTH)}`;
  assert.equal(safeGlobToRegExp('x'.repeat(MAX_RULE_PATTERN_LENGTH)).test('x'.repeat(MAX_RULE_PATTERN_LENGTH)), true);
  for (const pattern of [null, 12, '', longPattern, 'example.test/a b', 'example.test/a\u0000', 'example.test/a\u007f', 'example.test/a\n']) {
    assert.equal(safeGlobToRegExp(pattern), null);
  }
  const malformed = [null, 5, {}, { pattern: 9, category: 'Bad' }, { pattern: longPattern, category: 'Bad' }, { pattern: 'example.test/*' }];
  local[CACHE_SCHEMA.learningSchemaKey] = CACHE_SCHEMA.version;
  local[LearningCache.STORAGE_KEY] = [valid, ...malformed];
  assert.deepEqual(await LearningCache.getRules(), [valid]);
  local[LearningCache.STORAGE_KEY] = {};
  assert.deepEqual(await LearningCache.getRules(), []);

  const index = LearningCache.buildDomainIndex([
    ...malformed,
    { pattern: 'example.test/never/*', category: 'Bypass', _regex: { test: () => true } },
    valid,
    { pattern: 'EXAMPLE.TEST/Projects/Specific/***', category: 'Specific' },
    { pattern: 'example.test/projects/specific/hidden/*', category: 'Low confidence', confidence: 0.1 }
  ]);
  assert.equal(LearningCache.matchUrl('https://example.test/projects', index).category, 'Projects');
  assert.equal(LearningCache.matchUrl('https://example.test/PROJECTS/Specific/page', index).category, 'Specific');
  assert.equal(LearningCache.matchUrl('https://example.test/projects/specific/hidden/page', index).category, 'Specific');
  assert.equal(LearningCache.matchUrl('https://example.test/unrelated', index), null);
  assert.equal(LearningCache.matchUrl('https://example.test/projects-other', index), null);
  assert.equal(LearningCache.buildDomainIndex({}).size, 0);
});

test('PlanMemory writes are serialised, so concurrent writers lose nothing', async () => {
  installChromeStorageMock({ delayMs: 2 });
  const tabs = makeTabs(9);

  await Promise.all([
    PlanMemory.recordUserRename({ tabs: tabs.slice(0, 3), name: 'Recipes', color: 'green', keys: ['cat:food'] }),
    PlanMemory.recordUserRename({ tabs: tabs.slice(3, 6), name: 'Coding', color: 'blue', keys: ['cat:dev'] }),
    PlanMemory.recordUserRename({ tabs: tabs.slice(6, 9), name: 'Pasta Night', color: 'orange', keys: [] })
  ]);

  const memory = await PlanMemory.read();
  assert.deepEqual(memory.names.map(record => record.n).sort(), ['Coding', 'Pasta Night', 'Recipes']);
});

test('incognito tabs are never written to plan memory', async () => {
  const { local } = installChromeStorageMock();
  const tabs = makeTabs(2).map(tab => ({ ...tab, incognito: true }));

  await PlanMemory.recordUserRename({ tabs, name: 'Secret', color: 'red', keys: ['cat:dev'] });

  assert.deepEqual(local, {});
});

test('PlanMemory keeps model names 14 days and user renames 90 days', async () => {
  const { local } = installChromeStorageMock();
  const now = Date.now();
  local[PlanMemory.STORAGE_KEY] = {
    v: 1,
    names: [
      { k: ['cat:food'], w: [], f: [], n: 'Old Model', c: 'orange', s: 'nano', t: now - 15 * DAY_MS },
      { k: ['cat:food'], w: [], f: [], n: 'Fresh Model', c: 'orange', s: 'cloud', t: now - 13 * DAY_MS },
      { k: ['cat:dev'], w: [], f: ['fp-1'], n: 'Kept Rename', c: 'blue', s: 'user', t: now - 89 * DAY_MS },
      { k: ['cat:dev'], w: [], f: ['fp-2'], n: 'Expired Rename', c: 'blue', s: 'user', t: now - 91 * DAY_MS }
    ],
    advice: { cloud: { 'cat:games': 'cat:video' }, t: now }
  };

  const memory = await PlanMemory.read();
  assert.deepEqual(memory.names.map(record => record.n), ['Fresh Model', 'Kept Rename']);
  assert.deepEqual(memory.advice.cloud, { 'cat:games': 'cat:video' });

  local[PlanMemory.STORAGE_KEY].v = 2;
  assert.deepEqual(await PlanMemory.read(), { v: 1, names: [], advice: { cloud: {}, t: 0 } });
});

test('PlanMemory holds at most 120 names, newest first, evicting model names before user renames', async () => {
  const renamed = makeTabs(10, { start: 500 });
  const { local } = installChromeStorageMock();
  const now = Date.now();
  local[PlanMemory.STORAGE_KEY] = {
    v: 1,
    names: [
      ...Array.from({ length: 5 }, (_, index) => ({
        k: [`cat:${index}`], w: [], f: [`fp-${index}`], n: `Rename ${index}`, c: 'blue', s: 'user', t: now - 20 * DAY_MS
      })),
      ...Array.from({ length: 115 }, (_, index) => ({
        k: [`task:${index}`], w: [], f: [], n: `Model ${index}`, c: 'green', s: 'nano', t: now - DAY_MS - index
      }))
    ],
    advice: { cloud: {}, t: 0 }
  };

  for (const [index, tab] of renamed.entries()) {
    await PlanMemory.recordUserRename({ tabs: [tab], name: `New ${index}`, color: 'red', keys: [] });
  }

  const memory = await PlanMemory.read();
  assert.equal(memory.names.length, 120);
  assert.equal(memory.names.filter(record => record.s === 'user').length, 15);
  assert.equal(memory.names.filter(record => record.n.startsWith('New ')).length, 10);
  assert.ok(!memory.names.some(record => ['Model 105', 'Model 114'].includes(record.n)), 'oldest model names evicted');
  assert.ok(memory.names.some(record => record.n === 'Model 104'));
  for (let index = 1; index < memory.names.length; index++) {
    assert.ok(memory.names[index - 1].t >= memory.names[index].t, 'newest first');
  }
});

test('PlanMemory.recordUserRename stores fingerprints and replaces an earlier rename of the same tabs', async () => {
  const { local } = installChromeStorageMock();
  const food = makeTabs(5, { prefix: 'Food' });

  await PlanMemory.recordUserRename({ tabs: food, name: 'Recipes', color: 'green', keys: ['cat:food'] });
  let memory = await PlanMemory.read();
  assert.equal(memory.names.length, 1);
  const [record] = memory.names;
  assert.equal(record.s, 'user');
  assert.equal(record.n, 'Recipes');
  assert.equal(record.c, 'green');
  assert.deepEqual(record.k, ['cat:food']);
  assert.deepEqual(record.w, []);
  assert.deepEqual(record.f, await Promise.all(food.map(fingerprintTab)));
  assert.ok(!JSON.stringify(local).includes('secret'));

  // Renaming mostly the same tabs again supersedes the first rename.
  const grown = [...food.slice(1), ...makeTabs(1, { start: 40, prefix: 'Food' })];
  await PlanMemory.recordUserRename({ tabs: grown, name: 'Cooking', color: 'yellow', keys: ['cat:food'] });
  // A rename of unrelated tabs is kept alongside it, cut to 30 characters at a word.
  await PlanMemory.recordUserRename({ tabs: makeTabs(3, { start: 60 }), name: 'A name longer than forty characters in total', keys: [] });
  memory = await PlanMemory.read();
  assert.deepEqual(memory.names.map(item => item.n), ['A name longer than forty', 'Cooking']);

  await PlanMemory.recordUserRename({ tabs: food, name: '   ', color: 'green' });
  await PlanMemory.recordUserRename({ tabs: food, name: 'Review Later', color: 'grey' });
  await PlanMemory.recordUserRename({ tabs: [], name: 'Empty' });
  assert.equal((await PlanMemory.read()).names.length, 2);

  await PlanMemory.clear();
  assert.ok(!(PlanMemory.STORAGE_KEY in local));
});

test('normalizeUserGroupName keeps the user\'s words and cuts long names at a word', () => {
  assert.equal(normalizeUserGroupName('Work'), 'Work');
  assert.equal(normalizeUserGroupName('  Q3\t🚀   Launch \n'), 'Q3 🚀 Launch');
  assert.equal(normalizeUserGroupName('Client Phoenix – Q3 planning docs'), 'Client Phoenix – Q3 planning');
  assert.equal(normalizeUserGroupName('Taxes and receipts – 2026 – year end'), 'Taxes and receipts – 2026');
  assert.equal(normalizeUserGroupName('Exactly thirty characters long'), 'Exactly thirty characters long');
  assert.equal(normalizeUserGroupName('Supercalifragilisticexpialidocious'), 'Supercalifragilisticexpialidoc');
  for (const raw of ['', '   ', 'review later', null, 42]) assert.equal(normalizeUserGroupName(raw), '', String(raw));
});

test('PlanMemory reads older user names under the same rule it stores them with', async () => {
  const { local } = installChromeStorageMock();
  local[PlanMemory.STORAGE_KEY] = {
    v: 1,
    names: [
      { k: [], w: [], f: ['fp-1'], n: 'A name longer than forty characters in t', c: 'blue', s: 'user', t: Date.now() },
      { k: [], w: [], f: ['fp-2'], n: 'Review Later', c: 'grey', s: 'user', t: Date.now() - 1 },
      { k: [], w: [], f: ['fp-3'], n: 'Work', c: 'red', s: 'user', t: Date.now() - 2 }
    ],
    advice: { cloud: {}, t: 0 }
  };
  assert.deepEqual((await PlanMemory.read()).names.map(record => record.n), ['A name longer than forty', 'Work']);
});

test('recordUserRename keeps at most 60 fingerprints', async () => {
  installChromeStorageMock();
  await PlanMemory.recordUserRename({ tabs: makeTabs(75), name: 'Big Group', color: 'blue', keys: ['cat:read'] });
  const [record] = (await PlanMemory.read()).names;
  assert.equal(record.f.length, 60);
});

test('WindowPlanStore keeps one plan per window in session storage only', async () => {
  const { local, session } = installChromeStorageMock();
  const plan = {
    K: 4,
    n: 9,
    signature: 'cat:dev|cat:food',
    flags: ['oversized'],
    candidates: [{ key: 'cat:dev' }],
    groups: [
      { name: 'Coding', color: 'blue', keys: ['task:1', 'cat:dev'], tabIds: [1, 2, 3], dominant: 'dev', kind: 'category', titles: ['secret'], nameSource: 'deterministic' },
      { name: 'Food & Recipes', color: 'orange', keys: ['cat:food'], tabIds: [4, 5], dominant: 'food', kind: 'category' },
      { name: 'Review Later', color: 'grey', keys: ['review'], tabIds: [6], dominant: null, kind: 'review' }
    ]
  };

  assert.equal(await WindowPlanStore.get(7), null);
  await WindowPlanStore.put(7, plan);
  assert.deepEqual(local, {});
  assert.deepEqual(Object.keys(session), ['foldnex_window_plan_v1:7']);

  const stored = await WindowPlanStore.get(7);
  assert.equal(stored.v, 1);
  assert.equal(stored.windowId, 7);
  assert.equal(stored.K, 4);
  assert.equal(stored.signature, 'cat:dev|cat:food');
  assert.ok(stored.updatedAt > 0);
  assert.deepEqual(Object.keys(stored).sort(), ['K', 'g', 'groups', 'signature', 'updatedAt', 'v', 'windowId']);
  assert.deepEqual(stored.groups[0], {
    name: 'Coding', color: 'blue', keys: ['cat:dev', 'task:1'], tabIds: [1, 2, 3], dominant: 'dev', kind: 'category', nameSource: 'deterministic'
  });
  assert.equal(stored.groups[2].kind, 'review');
  assert.ok(!JSON.stringify(session).includes('secret'));

  assert.equal(await WindowPlanStore.get(8), null);
  await WindowPlanStore.put(-1, plan);
  await WindowPlanStore.put('not-a-window', plan);
  assert.deepEqual(Object.keys(session), ['foldnex_window_plan_v1:7']);

  await WindowPlanStore.remove(7);
  assert.deepEqual(session, {});
  assert.equal(await WindowPlanStore.get(7), null);
});

test('deleteRule clears only the exact cache; resetRules also clears plan memory, a leftover label cache and the legacy key', async () => {
  const { local } = installChromeStorageMock();
  await LearningCache.learnUserCorrections(['https://unifi.ui.com/network'], 'Network', 'cyan');
  const tabs = makeTabs(3);
  const context = await ExactResultCache.makeContext(tabs, 'labels-v1');
  await ExactResultCache.put(context, [{ name: 'Mixed', color: 'blue', tabIds: [1, 2, 3] }]);
  local.foldnex_tab_labels_v1 = { v: 'v2', g: 0, entries: {} };
  await PlanMemory.recordUserRename({ tabs: tabs.slice(0, 1), name: 'Network', color: 'cyan', keys: [] });
  local.foldnex_tab_assignments_v1 = { scope: 'dev', entries: {} };

  await LearningCache.deleteRule('unifi.ui.com/network/*');
  assert.ok(!(ExactResultCache.STORAGE_KEY in local));
  assert.ok(PlanMemory.STORAGE_KEY in local, 'plan memory does not depend on rules');
  assert.deepEqual(await LearningCache.getRules(), []);

  await LearningCache.learnUserCorrections(['https://unifi.ui.com/network'], 'Network', 'cyan');
  await LearningCache.resetRules();
  for (const key of ['foldnex_tab_labels_v1', PlanMemory.STORAGE_KEY, 'foldnex_tab_assignments_v1', LearningCache.STORAGE_KEY]) {
    assert.ok(!(key in local), `${key} removed`);
  }
  assert.equal(local.foldnex_learning_schema_version, 2);
  assert.ok(!('foldnex_legacy_rules_backup' in local), 'reset never moves rules into the legacy backup');
});

test('resetRules waits for queued plan memory writes so they cannot restore it', async () => {
  const { local } = installChromeStorageMock({ delayMs: 2 });
  const tabs = makeTabs(3);

  const pendingName = PlanMemory.recordUserRename({ tabs: tabs.slice(0, 2), name: 'Coding', color: 'blue', keys: [] });
  await LearningCache.resetRules();
  await pendingName;

  assert.ok(!(PlanMemory.STORAGE_KEY in local));
  assert.deepEqual((await PlanMemory.read()).names, []);
});

test('a reset from another context wins over a write that read before it', async () => {
  const { local, hooks } = installChromeStorageMock();
  // Separate module instances, like the service worker and the options page:
  // neither can see the other's write chain.
  const worker = await import('../src/cache-engine.js?context=worker');
  const options = await import('../src/cache-engine.js?context=options');
  const tabs = makeTabs(6);
  const scope = 'labels-v1';
  const context = await worker.ExactResultCache.makeContext(tabs, scope);
  const epochKey = 'foldnex_reset_epoch';

  const seed = async () => {
    await worker.PlanMemory.recordUserRename({ tabs: tabs.slice(0, 2), name: 'Recipes', color: 'green', keys: ['cat:food'] });
    await worker.LearningCache.learnGroupRename(tabs.slice(0, 2), 'Recipes', 'green');
    await worker.ExactResultCache.put(context, [{ name: 'Mixed', color: 'blue', tabIds: tabs.map(tab => tab.id) }]);
    await worker.LearningCache.learnUserCorrections(['https://unifi.ui.com/network'], 'Network', 'cyan');
    assert.equal((await worker.PlanMemory.read()).names.length, 1, 'seeded');
  };
  const assertCleared = async label => {
    for (const view of [worker, options]) {
      assert.deepEqual(await view.PlanMemory.read(), { v: 1, names: [], advice: { cloud: {}, t: 0 } }, label);
      const renamed = await view.LearningCache.applyGroupPreferences([
        { name: 'A', tabIds: [1, 2] }, { name: 'B', tabIds: [3, 4] }
      ], tabs);
      assert.deepEqual(renamed.map(group => group.name), ['A', 'B'], label);
      assert.equal((await view.ExactResultCache.get(tabs, scope)).groups, null, label);
    }
  };

  // [name, write, key, stamped]. Rules are a plain array without an epoch
  // stamp, so only the check before their write applies to them.
  const writes = [
    ['rename', () => worker.PlanMemory.recordUserRename({ tabs: tabs.slice(2, 4), name: 'Work', color: 'red', keys: [] }), PlanMemory.STORAGE_KEY, true],
    ['preferences', () => worker.LearningCache.learnGroupRename(tabs.slice(2, 4), 'Work', 'red'), CACHE_SCHEMA.groupPreferencesKey, true],
    ['exact', () => worker.ExactResultCache.put(context, [{ name: 'Other', color: 'red', tabIds: tabs.map(tab => tab.id) }]), ExactResultCache.STORAGE_KEY, true],
    ['rules', () => worker.LearningCache.learnUserCorrections(['https://example.org/a'], 'Example', 'red'), LearningCache.STORAGE_KEY, false]
  ];
  const reset = () => options.LearningCache.resetRules();
  const moments = {
    // The worker has read its record; the reset lands before its write.
    afterRead: key => {
      hooks.afterGet = async keys => {
        if (keys.length !== 2 || !keys.includes(key) || !keys.includes(epochKey)) return;
        hooks.afterGet = null;
        await reset();
      };
      return () => hooks.afterGet === null;
    },
    // The worker has passed its epoch check; the reset lands before its set.
    beforeSet: key => {
      hooks.beforeSet = async values => {
        if (!(key in values)) return;
        hooks.beforeSet = null;
        await reset();
      };
      return () => hooks.beforeSet === null;
    }
  };

  let resets = 0;
  for (const [moment, arm] of Object.entries(moments)) {
    for (const [name, write, key, stamped] of writes) {
      if (moment === 'beforeSet' && !stamped) continue;
      await seed();
      const fired = arm(key);
      await write();
      const label = `${name}, reset ${moment}`;
      assert.ok(fired(), `${label}: the reset ran inside the write`);
      assert.equal(local[epochKey], ++resets, label);
      await assertCleared(label);
      if (name === 'rules') {
        assert.deepEqual(await options.LearningCache.getRules(), [], label);
      }
    }
  }

  // The first write after a reset starts from an empty record.
  await worker.PlanMemory.recordUserRename({ tabs: tabs.slice(4, 6), name: 'After Reset', color: 'blue', keys: [] });
  assert.deepEqual((await options.PlanMemory.read()).names.map(record => record.n), ['After Reset']);
  assert.equal(local[PlanMemory.STORAGE_KEY].g, resets);
});

test('records written before the reset epoch existed stay readable until the first reset', async () => {
  const { local } = installChromeStorageMock();
  const tabs = makeTabs(4);
  const scope = 'labels-v1';
  const context = await ExactResultCache.makeContext(tabs, scope);
  await PlanMemory.recordUserRename({ tabs: tabs.slice(0, 2), name: 'Recipes', color: 'green', keys: ['cat:food'] });
  await LearningCache.learnGroupRename(tabs.slice(0, 2), 'Recipes', 'green');
  await ExactResultCache.put(context, [{ name: 'Mixed', color: 'blue', tabIds: tabs.map(tab => tab.id) }]);

  // The shipped version stored no epoch stamp and no epoch key.
  delete local.foldnex_reset_epoch;
  delete local[PlanMemory.STORAGE_KEY].g;
  for (const preference of local[CACHE_SCHEMA.groupPreferencesKey]) delete preference.g;
  for (const record of local[ExactResultCache.STORAGE_KEY]) delete record.g;

  const readAll = async () => ({
    names: (await PlanMemory.read()).names.map(record => record.n),
    preferred: (await LearningCache.applyGroupPreferences([{ name: 'A', tabIds: [1, 2] }], tabs))[0].name,
    exact: Boolean((await ExactResultCache.get(tabs, scope)).groups)
  });
  assert.deepEqual(await readAll(), { names: ['Recipes'], preferred: 'Recipes', exact: true });

  // A new write keeps the older records beside its own.
  await PlanMemory.recordUserRename({ tabs: tabs.slice(2, 4), name: 'Work', color: 'red', keys: [] });
  await LearningCache.learnGroupRename(tabs.slice(2, 4), 'Work', 'red');
  assert.deepEqual((await PlanMemory.read()).names.map(record => record.n).sort(), ['Recipes', 'Work']);
  assert.equal((await LearningCache.applyGroupPreferences([{ name: 'A', tabIds: [1, 2] }], tabs))[0].name, 'Recipes');

  await LearningCache.resetRules();
  assert.deepEqual(await readAll(), { names: [], preferred: 'A', exact: false });
});

test('an explicit operation epoch fences delayed results while fresh results may reuse fingerprints and contexts', async () => {
  const { local, session } = installChromeStorageMock();
  const worker = await import('../src/cache-engine.js?context=origin-worker');
  const options = await import('../src/cache-engine.js?context=origin-options');
  const tabs = makeTabs(2);
  const context = await worker.ExactResultCache.makeContext(tabs, 'origin');
  const groups = [{ name: 'Model Name', color: 'blue', tabIds: [1, 2], keys: ['cat:dev'] }];
  const epoch = await worker.readResetEpoch();
  assert.equal(epoch, 0);
  await options.LearningCache.resetRules();
  assert.equal(await worker.readResetEpoch(), 1);

  const save = async origin => {
    await worker.PlanMemory.recordUserRename({ tabs, name: 'My Group', keys: ['cat:dev'] }, origin);
    await worker.LearningCache.learnGroupRename(tabs, 'My Group', 'green', origin);
    await worker.LearningCache.learnFromGroupings([{ name: 'Work', tabs: [{ url: 'https://example.test/work' }] }], origin);
    await worker.LearningCache.learnUserCorrections(['https://example.test/work'], 'Work', 'blue', origin);
    await worker.ExactResultCache.put(context, groups, origin);
    await worker.WindowPlanStore.put(7, { groups, signature: 'origin' }, origin);
  };
  await save({ epoch });
  assert.equal((await worker.PlanMemory.read()).names.length, 0);
  assert.deepEqual(await worker.LearningCache.getRules(), []);
  assert.equal((await worker.ExactResultCache.get(tabs, 'origin')).groups, null);
  assert.equal(await worker.WindowPlanStore.get(7), null);
  assert.deepEqual(session, {});

  // Fresh work explicitly reuses these pre-reset data objects. They carry no
  // generation: the supplied operation epoch decides whether saving is safe.
  await save({ epoch: await worker.readResetEpoch() });
  assert.deepEqual((await options.PlanMemory.read()).names.map(record => record.n), ['My Group']);
  assert.equal((await options.LearningCache.getRules()).length, 1);
  assert.equal((await options.LearningCache.applyGroupPreferences(groups, tabs))[0].name, 'My Group');
  assert.equal((await options.ExactResultCache.get(tabs, 'origin')).groups[0].name, 'Model Name');
  assert.equal((await options.WindowPlanStore.get(7)).g, 1);
  const freshState = structuredClone({ local, session });
  await save({ epoch });
  await save({ epoch: '1' });
  await worker.LearningCache.deleteRule('example.test/work/*', { epoch });
  assert.deepEqual({ local, session }, freshState, 'late pre-reset results cannot overwrite fresh state');
});

test('writes without an explicit origin capture their epoch before waiting behind another write', async () => {
  const { local, session, hooks } = installChromeStorageMock();
  const worker = await import('../src/cache-engine.js?context=queued-origin-worker');
  const options = await import('../src/cache-engine.js?context=queued-origin-options');
  const tabs = makeTabs(2);
  const context = await worker.ExactResultCache.makeContext(tabs, 'queued');
  const blocker = await worker.ExactResultCache.makeContext(makeTabs(2, { start: 90 }), 'blocker');
  const groups = [{ name: 'Old Result', tabIds: [1, 2] }];
  let started;
  let release;
  const blocked = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  hooks.beforeSet = async values => {
    if (!(ExactResultCache.STORAGE_KEY in values)) return;
    hooks.beforeSet = null;
    started();
    await gate;
  };
  const first = worker.ExactResultCache.put(blocker, [{ name: 'Blocker', tabIds: [90, 91] }], { epoch: 0 });
  await blocked;
  let captured;
  const allCaptured = new Promise(resolve => { captured = resolve; });
  let origins = 0;
  hooks.afterGet = keys => {
    if (keys.length === 1 && keys[0] === 'foldnex_reset_epoch' && ++origins === 4) {
      hooks.afterGet = null;
      captured();
    }
  };
  const pending = [
    worker.PlanMemory.recordUserRename({ tabs, name: 'Old Rename' }),
    worker.LearningCache.learnGroupRename(tabs, 'Old Preference', 'red'),
    worker.ExactResultCache.put(context, groups),
    worker.WindowPlanStore.put(7, { groups })
  ];
  await allCaptured;
  await options.LearningCache.resetRules();
  release();
  await Promise.all([first, ...pending]);
  assert.deepEqual(await options.PlanMemory.read(), { v: 1, names: [], advice: { cloud: {}, t: 0 } });
  assert.equal((await options.ExactResultCache.get(tabs, 'queued')).groups, null);
  assert.equal(await options.WindowPlanStore.get(7), null);
  assert.ok(!(PlanMemory.STORAGE_KEY in local), 'queued old work did not create new-generation memory');
  assert.deepEqual(session, {});
});

test('rename writes capture their origin before asynchronous fingerprinting', async () => {
  const { local } = installChromeStorageMock();
  const worker = await import('../src/cache-engine.js?context=fingerprint-worker');
  const options = await import('../src/cache-engine.js?context=fingerprint-options');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    for (const rename of [
      () => worker.PlanMemory.recordUserRename({ tabs: makeTabs(2), name: 'Before Reset' }),
      () => worker.LearningCache.learnGroupRename(makeTabs(2), 'Before Reset', 'red')
    ]) {
      let started;
      let release;
      const blocked = new Promise(resolve => { started = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: { subtle: { async digest() { started(); await gate; return new Uint8Array(32).buffer; } } }
      });
      const pending = rename();
      await blocked;
      await options.LearningCache.resetRules();
      release();
      await pending;
      assert.ok(!(PlanMemory.STORAGE_KEY in local));
      assert.ok(!(CACHE_SCHEMA.groupPreferencesKey in local));
    }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else delete globalThis.crypto;
  }
});

test('window plans from an older generation stay unreadable when their session write lands after reset', async () => {
  const { session, hooks } = installChromeStorageMock();
  const worker = await import('../src/cache-engine.js?context=plan-worker');
  const options = await import('../src/cache-engine.js?context=plan-options');
  const plan = { groups: [{ name: 'Old Plan', tabIds: [1] }] };
  const key = worker.WindowPlanStore.keyFor(7);
  await worker.WindowPlanStore.put(7, plan);
  delete session[key].g;
  assert.equal((await worker.WindowPlanStore.get(7)).groups[0].name, 'Old Plan', 'an unstamped legacy plan works before the first reset');
  await options.LearningCache.resetRules();
  assert.equal(await worker.WindowPlanStore.get(7), null, 'reset invalidates existing session plans');
  let resetRan = false;
  hooks.beforeSet = async values => {
    if (!(key in values)) return;
    hooks.beforeSet = null;
    await options.LearningCache.resetRules();
    resetRan = true;
  };
  await worker.WindowPlanStore.put(7, plan);
  assert.equal(resetRan, true);
  assert.equal(session[key].g, 1, 'the delayed write retains the generation it began in');
  assert.equal(await worker.WindowPlanStore.get(7), null);
  assert.equal(await options.WindowPlanStore.get(7), null);
  await worker.WindowPlanStore.put(7, { groups: [{ name: 'Fresh Plan', tabIds: [1] }] });
  assert.equal((await options.WindowPlanStore.get(7)).groups[0].name, 'Fresh Plan');
  assert.equal((await options.WindowPlanStore.get(7)).g, 2);
});

test('a delayed old rename does not clear an exact result saved after reset', async () => {
  const { hooks } = installChromeStorageMock();
  const worker = await import('../src/cache-engine.js?context=rename-clear-worker');
  const options = await import('../src/cache-engine.js?context=rename-clear-options');
  const tabs = makeTabs(2);
  const context = await worker.ExactResultCache.makeContext(tabs, 'rename-clear');
  hooks.beforeSet = async values => {
    if (!(CACHE_SCHEMA.groupPreferencesKey in values)) return;
    hooks.beforeSet = null;
    await options.LearningCache.resetRules();
    await options.ExactResultCache.put(context, [{ name: 'Fresh Result', tabIds: [1, 2] }]);
  };
  await worker.LearningCache.learnGroupRename(tabs, 'Old Rename', 'blue');
  assert.equal((await worker.ExactResultCache.get(tabs, 'rename-clear')).groups[0].name, 'Fresh Result');
  assert.equal((await worker.LearningCache.applyGroupPreferences([{ name: 'Original', tabIds: [1, 2] }], tabs))[0].name, 'Original');
});

test('a failed write does not block later writes', async () => {
  installChromeStorageMock();
  const tabs = makeTabs(1);
  const originalSet = chrome.storage.local.set;
  chrome.storage.local.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
  await assert.rejects(PlanMemory.recordUserRename({ tabs, name: 'Coding', color: 'blue', keys: [] }), /quota/);
  chrome.storage.local.set = originalSet;

  await PlanMemory.recordUserRename({ tabs, name: 'Coding', color: 'blue', keys: [] });
  assert.deepEqual((await PlanMemory.read()).names.map(record => record.n), ['Coding']);
  await PlanMemory.clear();
  assert.deepEqual((await PlanMemory.read()).names, []);
});
