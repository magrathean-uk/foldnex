import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import {
  CACHE_SCHEMA,
  ExactResultCache,
  LearningCache,
  MAX_RULE_PATTERN_LENGTH,
  PlanMemory,
  TabLabelCache,
  WindowPlanStore,
  fingerprintTab,
  hashToken,
  normalizeUserGroupName,
  readResetEpoch,
  safeGlobToRegExp,
  sanitizeTitle
} from '../src/cache-engine.js';
import { LABEL_VOCAB_VERSION } from '../src/label-vocabulary.js';

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

test('TabLabelCache stores model labels by fingerprint and returns them on lookup', async () => {
  const { local } = installChromeStorageMock();
  const tabs = makeTabs(4);

  const cold = await TabLabelCache.lookup(tabs, { acceptEngines: null });
  assert.equal(cold.labels.size, 0);
  assert.deepEqual(cold.missing.map(tab => tab.id), [1, 2, 3, 4]);
  assert.equal(cold.fingerprintById.size, 4);
  assert.equal(cold.fingerprintById.get(1), await fingerprintTab(tabs[0]));

  await TabLabelCache.store(new Map([[1, 'dev'], [2, 'food'], [3, 'not-a-category'], [99, 'news']]), cold.fingerprintById, 'gemini_nano');

  const warm = await TabLabelCache.lookup(tabs, { acceptEngines: null });
  assert.deepEqual([...warm.labels], [[1, { c: 'dev', e: 'gemini_nano' }], [2, { c: 'food', e: 'gemini_nano' }]]);
  assert.deepEqual(warm.missing.map(tab => tab.id), [3, 4]);

  const record = local[TabLabelCache.STORAGE_KEY];
  assert.equal(record.v, LABEL_VOCAB_VERSION);
  assert.equal(Object.keys(record.entries).length, 2);
  for (const entry of Object.values(record.entries)) {
    assert.deepEqual(Object.keys(entry).sort(), ['c', 'e', 't']);
  }
  const serialised = JSON.stringify(local);
  assert.ok(!serialised.includes('secret'), 'no title text is stored');
  assert.ok(!serialised.includes('example-'), 'no URL is stored');

  // Labels are context-free: the same content in another window reuses them.
  const otherWindow = tabs.slice(0, 2).map(tab => ({ ...tab, id: tab.id + 500, windowId: 9 }));
  const reused = await TabLabelCache.lookup(otherWindow);
  assert.deepEqual([...reused.labels.keys()], [501, 502]);
});

test('TabLabelCache only gives cloud engines labels a cloud engine wrote', async () => {
  installChromeStorageMock();
  const tabs = makeTabs(2);
  const { fingerprintById } = await TabLabelCache.lookup(tabs);
  await TabLabelCache.store(new Map([[1, 'travel']]), fingerprintById, 'gemini_nano');
  await TabLabelCache.store(new Map([[2, 'shop']]), fingerprintById, 'openai');

  const cloud = await TabLabelCache.lookup(tabs, { acceptEngines: new Set(CLOUD_ENGINES) });
  assert.deepEqual([...cloud.labels], [[2, { c: 'shop', e: 'openai' }]]);
  assert.deepEqual(cloud.missing.map(tab => tab.id), [1]);

  const local = await TabLabelCache.lookup(tabs, { acceptEngines: null });
  assert.equal(local.labels.size, 2);

  // A cloud label replaces the Nano one, so the next cloud click is warm.
  await TabLabelCache.store(new Map([[1, 'travel']]), cloud.fingerprintById, 'anthropic');
  const upgraded = await TabLabelCache.lookup(tabs, { acceptEngines: CLOUD_ENGINES });
  assert.equal(upgraded.missing.length, 0);
  assert.equal(upgraded.labels.get(1).e, 'anthropic');
});

test('TabLabelCache ignores a vocabulary mismatch, expired entries and unknown keys', async () => {
  const { local } = installChromeStorageMock();
  const tabs = makeTabs(3);
  const fingerprints = await Promise.all(tabs.map(fingerprintTab));

  local[TabLabelCache.STORAGE_KEY] = {
    v: 'v0',
    entries: { [fingerprints[0]]: { c: 'dev', t: Date.now(), e: 'openai' } }
  };
  assert.equal((await TabLabelCache.lookup(tabs)).labels.size, 0);
  assert.deepEqual(await TabLabelCache.read(), {});

  local[TabLabelCache.STORAGE_KEY] = {
    v: LABEL_VOCAB_VERSION,
    entries: {
      [fingerprints[0]]: { c: 'dev', t: Date.now() - 8 * DAY_MS, e: 'openai' },
      [fingerprints[1]]: { c: 'social', t: Date.now(), e: 'openai' },
      [fingerprints[2]]: { c: 'news', t: Date.now() - 6 * DAY_MS, e: 'openai' }
    }
  };
  const result = await TabLabelCache.lookup(tabs);
  assert.deepEqual([...result.labels.keys()], [3]);

  // A store drops expired and invalid entries from the record.
  await TabLabelCache.store(new Map([[1, 'dev']]), result.fingerprintById, 'openai');
  assert.deepEqual(Object.keys(local[TabLabelCache.STORAGE_KEY].entries).sort(), [fingerprints[0], fingerprints[2]].sort());
});

test('TabLabelCache keeps only the 3,000 newest entries', async () => {
  const { local } = installChromeStorageMock();
  const now = Date.now();
  const entries = {};
  for (let index = 0; index < 3000; index++) {
    entries[`old-${String(index).padStart(4, '0')}`] = { c: 'read', t: now - DAY_MS + index, e: 'gemini_nano' };
  }
  local[TabLabelCache.STORAGE_KEY] = { v: LABEL_VOCAB_VERSION, entries };

  const tabs = makeTabs(5);
  const { fingerprintById } = await TabLabelCache.lookup(tabs);
  await TabLabelCache.store(new Map(tabs.map(tab => [tab.id, 'games'])), fingerprintById, 'gemini_nano');

  const stored = local[TabLabelCache.STORAGE_KEY].entries;
  assert.equal(Object.keys(stored).length, 3000);
  for (const fingerprint of fingerprintById.values()) assert.equal(stored[fingerprint].c, 'games');
  for (let index = 0; index < 5; index++) assert.ok(!(`old-000${index}` in stored), `oldest entry ${index} trimmed`);
  assert.ok('old-0005' in stored);
});

test('TabLabelCache and PlanMemory writes are serialised, so concurrent writers lose nothing', async () => {
  const { local } = installChromeStorageMock({ delayMs: 2 });
  const tabs = makeTabs(10);
  const { fingerprintById } = await TabLabelCache.lookup(tabs);

  await Promise.all([
    ...tabs.map(tab => TabLabelCache.store(new Map([[tab.id, 'dev']]), fingerprintById, 'gemini_nano')),
    PlanMemory.putNames([{ k: ['cat:food'], w: [hashToken('pasta')], n: 'Pasta Night', c: 'orange', s: 'nano' }]),
    PlanMemory.recordUserRename({ tabs: tabs.slice(0, 3), name: 'Recipes', color: 'green', keys: ['cat:food'] }),
    PlanMemory.putAdvice({ 'cat:games': 'cat:video' }),
    PlanMemory.putNames([{ k: ['cat:dev'], w: [], n: 'Coding', c: 'blue', s: 'cloud' }])
  ]);

  assert.equal(Object.keys(local[TabLabelCache.STORAGE_KEY].entries).length, 10);
  const memory = await PlanMemory.read();
  assert.deepEqual(memory.names.map(record => record.n).sort(), ['Coding', 'Pasta Night', 'Recipes']);
  assert.deepEqual(memory.advice.cloud, { 'cat:games': 'cat:video' });
});

test('incognito tabs are never read from or written to the label cache or plan memory', async () => {
  const { local } = installChromeStorageMock();
  const tabs = makeTabs(2).map(tab => ({ ...tab, incognito: true }));

  const result = await TabLabelCache.lookup(tabs);
  assert.equal(result.fingerprintById.size, 0);
  assert.deepEqual(result.missing.map(tab => tab.id), [1, 2]);
  await TabLabelCache.store(new Map([[1, 'dev'], [2, 'dev']]), result.fingerprintById, 'gemini_nano');
  await PlanMemory.recordUserRename({ tabs, name: 'Secret', color: 'red', keys: ['cat:dev'] });

  assert.deepEqual(local, {});
});

test('PlanMemory.putNames stores hashed model names and replaces a newer name for the same group', async () => {
  const { local } = installChromeStorageMock();
  const japan = [hashToken('japan'), hashToken('tokyo'), hashToken('kyoto')];
  const paris = [hashToken('paris'), hashToken('louvre')];

  await PlanMemory.putNames([
    { k: ['task:abc', 'cat:travel'], w: japan, n: 'Japan Trip', c: 'cyan', s: 'nano', f: ['should-not-be-kept'] },
    { k: ['cat:travel'], w: [...paris, 'louvre', 'raw words'], n: '  Paris\nWeekend  ', c: 'not-a-colour', s: 'cloud' },
    { k: ['cat:food'], w: [], n: '   ', c: 'orange', s: 'nano' }
  ]);

  let memory = await PlanMemory.read();
  assert.equal(memory.v, 1);
  assert.equal(memory.names.length, 2);
  const japanRecord = memory.names.find(record => record.n === 'Japan Trip');
  assert.deepEqual(japanRecord.k, ['cat:travel', 'task:abc']);
  assert.deepEqual(japanRecord.w, japan);
  assert.deepEqual(japanRecord.f, []);
  assert.equal(japanRecord.s, 'nano');
  const parisRecord = memory.names.find(record => record.n === 'Paris Weekend');
  assert.deepEqual(parisRecord.w, paris);
  assert.equal(parisRecord.c, null);
  assert.equal(parisRecord.s, 'cloud');

  const serialised = JSON.stringify(local);
  for (const word of ['japan', 'tokyo', 'paris', 'louvre', 'raw words', 'should-not-be-kept']) {
    assert.ok(!serialised.includes(word), `${word} is not stored`);
  }

  // A newer model name for the same keys and tokens replaces the old one; a
  // same-keyed group with different tokens is a different group and stays.
  await PlanMemory.putNames([{ k: ['cat:travel', 'task:abc'], w: japan.slice(0, 2), n: 'Japan 2026', c: 'cyan', s: 'cloud' }]);
  memory = await PlanMemory.read();
  assert.deepEqual(memory.names.map(record => record.n), ['Japan 2026', 'Paris Weekend']);
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

  await PlanMemory.putNames(Array.from({ length: 10 }, (_, index) => ({
    k: [`split:${index}`], w: [], n: `New ${index}`, c: 'red', s: 'cloud'
  })));

  const memory = await PlanMemory.read();
  assert.equal(memory.names.length, 120);
  assert.equal(memory.names.filter(record => record.s === 'user').length, 5);
  assert.equal(memory.names.filter(record => record.n.startsWith('New ')).length, 10);
  assert.ok(!memory.names.some(record => ['Model 105', 'Model 114'].includes(record.n)), 'oldest model names evicted');
  assert.ok(memory.names.some(record => record.n === 'Model 104'));
  for (let index = 1; index < memory.names.length; index++) {
    assert.ok(memory.names[index - 1].t >= memory.names[index].t, 'newest first');
  }
});

test('PlanMemory.putAdvice merges cloud advice, retires reversed pairs and caps at 200', async () => {
  installChromeStorageMock();
  await PlanMemory.putAdvice({ 'cat:games': 'cat:video', 'cat:cars': 'cat:shop', 'cat:home': 'cat:money' });
  await PlanMemory.putAdvice(new Map([
    ['cat:games', 'cat:sport'],
    ['cat:shop', 'cat:cars'],
    ['cat:home', 'cat:home'],
    ['cat:news', 42]
  ]));

  let memory = await PlanMemory.read();
  assert.deepEqual(memory.advice.cloud, { 'cat:games': 'cat:sport', 'cat:shop': 'cat:cars' });
  assert.ok(memory.advice.t > 0);

  await PlanMemory.putAdvice(Array.from({ length: 210 }, (_, index) => [`task:${index}`, 'cat:dev']));
  memory = await PlanMemory.read();
  const keys = Object.keys(memory.advice.cloud);
  assert.equal(keys.length, 200);
  assert.equal(keys[0], 'task:0');
  assert.ok(!('cat:games' in memory.advice.cloud), 'older pairs fall off first');
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

test('deleteRule clears only the exact cache; resetRules also clears labels, plan memory and the legacy key', async () => {
  const { local } = installChromeStorageMock();
  await LearningCache.learnUserCorrections(['https://unifi.ui.com/network'], 'Network', 'cyan');
  const tabs = makeTabs(3);
  const context = await ExactResultCache.makeContext(tabs, 'labels-v1');
  await ExactResultCache.put(context, [{ name: 'Mixed', color: 'blue', tabIds: [1, 2, 3] }]);
  const { fingerprintById } = await TabLabelCache.lookup(tabs);
  await TabLabelCache.store(new Map([[1, 'infra']]), fingerprintById, 'gemini_nano');
  await PlanMemory.putNames([{ k: ['cat:infra'], w: [], n: 'Network', c: 'cyan', s: 'nano' }]);
  local.foldnex_tab_assignments_v1 = { scope: 'dev', entries: {} };

  await LearningCache.deleteRule('unifi.ui.com/network/*');
  assert.ok(!(ExactResultCache.STORAGE_KEY in local));
  assert.ok(TabLabelCache.STORAGE_KEY in local, 'labels do not depend on rules');
  assert.ok(PlanMemory.STORAGE_KEY in local, 'plan memory does not depend on rules');
  assert.deepEqual(await LearningCache.getRules(), []);

  await LearningCache.learnUserCorrections(['https://unifi.ui.com/network'], 'Network', 'cyan');
  await LearningCache.resetRules();
  for (const key of [TabLabelCache.STORAGE_KEY, PlanMemory.STORAGE_KEY, 'foldnex_tab_assignments_v1', LearningCache.STORAGE_KEY]) {
    assert.ok(!(key in local), `${key} removed`);
  }
  assert.equal(local.foldnex_learning_schema_version, 2);
  assert.ok(!('foldnex_legacy_rules_backup' in local), 'reset never moves rules into the legacy backup');
});

test('resetRules waits for queued label writes so they cannot restore the cache', async () => {
  const { local } = installChromeStorageMock({ delayMs: 2 });
  const tabs = makeTabs(3);
  const { fingerprintById } = await TabLabelCache.lookup(tabs);

  const pending = TabLabelCache.store(new Map([[1, 'dev'], [2, 'dev']]), fingerprintById, 'gemini_nano');
  const pendingName = PlanMemory.putNames([{ k: ['cat:dev'], w: [], n: 'Coding', c: 'blue', s: 'nano' }]);
  await LearningCache.resetRules();
  await Promise.all([pending, pendingName]);

  assert.ok(!(TabLabelCache.STORAGE_KEY in local));
  assert.ok(!(PlanMemory.STORAGE_KEY in local));
  assert.equal((await TabLabelCache.lookup(tabs)).labels.size, 0);
});

test('a reset from another context wins over a write that read before it', async () => {
  const { local, hooks } = installChromeStorageMock();
  // Separate module instances, like the service worker and the options page:
  // neither can see the other's write chain.
  const worker = await import('../src/cache-engine.js?context=worker');
  const options = await import('../src/cache-engine.js?context=options');
  const tabs = makeTabs(6);
  const scope = 'labels-v1';
  const { fingerprintById } = await worker.TabLabelCache.lookup(tabs);
  const context = await worker.ExactResultCache.makeContext(tabs, scope);
  const epochKey = 'foldnex_reset_epoch';

  const seed = async () => {
    await worker.TabLabelCache.store(new Map([[1, 'food']]), fingerprintById, 'gemini_nano');
    await worker.PlanMemory.recordUserRename({ tabs: tabs.slice(0, 2), name: 'Recipes', color: 'green', keys: ['cat:food'] });
    await worker.PlanMemory.putAdvice({ 'cat:games': 'cat:video' });
    await worker.LearningCache.learnGroupRename(tabs.slice(0, 2), 'Recipes', 'green');
    await worker.ExactResultCache.put(context, [{ name: 'Mixed', color: 'blue', tabIds: tabs.map(tab => tab.id) }]);
    await worker.LearningCache.learnUserCorrections(['https://unifi.ui.com/network'], 'Network', 'cyan');
    assert.equal((await worker.TabLabelCache.lookup(tabs)).labels.size, 1, 'seeded');
  };
  const assertCleared = async label => {
    for (const view of [worker, options]) {
      assert.equal((await view.TabLabelCache.lookup(tabs)).labels.size, 0, label);
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
    ['labels', () => worker.TabLabelCache.store(new Map([[2, 'travel']]), fingerprintById, 'openai'), TabLabelCache.STORAGE_KEY, true],
    ['names', () => worker.PlanMemory.putNames([{ k: ['cat:dev'], w: [], n: 'Coding', c: 'blue', s: 'nano' }]), PlanMemory.STORAGE_KEY, true],
    ['advice', () => worker.PlanMemory.putAdvice({ 'cat:cars': 'cat:travel' }), PlanMemory.STORAGE_KEY, true],
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
  await worker.TabLabelCache.store(new Map([[3, 'dev']]), fingerprintById, 'gemini_nano');
  assert.deepEqual([...(await options.TabLabelCache.lookup(tabs)).labels.keys()], [3]);
  assert.equal(local[TabLabelCache.STORAGE_KEY].g, resets);
});

test('records written before the reset epoch existed stay readable until the first reset', async () => {
  const { local } = installChromeStorageMock();
  const tabs = makeTabs(4);
  const scope = 'labels-v1';
  const { fingerprintById } = await TabLabelCache.lookup(tabs);
  const context = await ExactResultCache.makeContext(tabs, scope);
  await TabLabelCache.store(new Map([[1, 'food']]), fingerprintById, 'gemini_nano');
  await PlanMemory.recordUserRename({ tabs: tabs.slice(0, 2), name: 'Recipes', color: 'green', keys: ['cat:food'] });
  await LearningCache.learnGroupRename(tabs.slice(0, 2), 'Recipes', 'green');
  await ExactResultCache.put(context, [{ name: 'Mixed', color: 'blue', tabIds: tabs.map(tab => tab.id) }]);

  // The shipped version stored no epoch stamp and no epoch key.
  delete local.foldnex_reset_epoch;
  delete local[TabLabelCache.STORAGE_KEY].g;
  delete local[PlanMemory.STORAGE_KEY].g;
  for (const preference of local[CACHE_SCHEMA.groupPreferencesKey]) delete preference.g;
  for (const record of local[ExactResultCache.STORAGE_KEY]) delete record.g;

  const readAll = async () => ({
    labels: (await TabLabelCache.lookup(tabs)).labels.size,
    names: (await PlanMemory.read()).names.map(record => record.n),
    preferred: (await LearningCache.applyGroupPreferences([{ name: 'A', tabIds: [1, 2] }], tabs))[0].name,
    exact: Boolean((await ExactResultCache.get(tabs, scope)).groups)
  });
  assert.deepEqual(await readAll(), { labels: 1, names: ['Recipes'], preferred: 'Recipes', exact: true });

  // A new write keeps the older records beside its own.
  await TabLabelCache.store(new Map([[2, 'dev']]), fingerprintById, 'gemini_nano');
  await LearningCache.learnGroupRename(tabs.slice(2, 4), 'Work', 'red');
  assert.equal((await TabLabelCache.lookup(tabs)).labels.size, 2);
  assert.equal((await LearningCache.applyGroupPreferences([{ name: 'A', tabIds: [1, 2] }], tabs))[0].name, 'Recipes');

  await LearningCache.resetRules();
  assert.deepEqual(await readAll(), { labels: 0, names: [], preferred: 'A', exact: false });
});

test('an explicit operation epoch fences delayed results while fresh results may reuse fingerprints and contexts', async () => {
  const { local, session } = installChromeStorageMock();
  const worker = await import('../src/cache-engine.js?context=origin-worker');
  const options = await import('../src/cache-engine.js?context=origin-options');
  const tabs = makeTabs(2);
  const { fingerprintById } = await worker.TabLabelCache.lookup(tabs);
  const context = await worker.ExactResultCache.makeContext(tabs, 'origin');
  const groups = [{ name: 'Model Name', color: 'blue', tabIds: [1, 2], keys: ['cat:dev'] }];
  const epoch = await worker.readResetEpoch();
  assert.equal(epoch, 0);
  await options.LearningCache.resetRules();
  assert.equal(await worker.readResetEpoch(), 1);

  const save = async origin => {
    await worker.TabLabelCache.store(new Map([[1, 'dev']]), fingerprintById, 'openai', origin);
    await worker.PlanMemory.putNames([{ k: ['cat:dev'], w: [], n: 'Model Name', s: 'cloud' }], origin);
    await worker.PlanMemory.putAdvice({ 'cat:games': 'cat:video' }, origin);
    await worker.PlanMemory.recordUserRename({ tabs, name: 'My Group', keys: ['cat:dev'] }, origin);
    await worker.LearningCache.learnGroupRename(tabs, 'My Group', 'green', origin);
    await worker.LearningCache.learnFromGroupings([{ name: 'Work', tabs: [{ url: 'https://example.test/work' }] }], origin);
    await worker.LearningCache.learnUserCorrections(['https://example.test/work'], 'Work', 'blue', origin);
    await worker.ExactResultCache.put(context, groups, origin);
    await worker.WindowPlanStore.put(7, { groups, signature: 'origin' }, origin);
  };
  await save({ epoch });
  assert.equal((await worker.TabLabelCache.lookup(tabs)).labels.size, 0);
  assert.equal((await worker.PlanMemory.read()).names.length, 0);
  assert.deepEqual(await worker.LearningCache.getRules(), []);
  assert.equal((await worker.ExactResultCache.get(tabs, 'origin')).groups, null);
  assert.equal(await worker.WindowPlanStore.get(7), null);
  assert.deepEqual(session, {});

  // Fresh work explicitly reuses these pre-reset data objects. They carry no
  // generation: the supplied operation epoch decides whether saving is safe.
  await save({ epoch: await worker.readResetEpoch() });
  assert.equal((await options.TabLabelCache.lookup(tabs)).labels.size, 1);
  assert.deepEqual((await options.PlanMemory.read()).names.map(record => record.n).sort(), ['Model Name', 'My Group']);
  assert.deepEqual((await options.PlanMemory.read()).advice.cloud, { 'cat:games': 'cat:video' });
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
  const { fingerprintById } = await worker.TabLabelCache.lookup(tabs);
  const context = await worker.ExactResultCache.makeContext(tabs, 'queued');
  const groups = [{ name: 'Old Result', tabIds: [1, 2] }];
  let started;
  let release;
  const blocked = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  hooks.beforeSet = async values => {
    if (!(TabLabelCache.STORAGE_KEY in values)) return;
    hooks.beforeSet = null;
    started();
    await gate;
  };
  const first = worker.TabLabelCache.store(new Map([[1, 'food']]), fingerprintById, 'openai', { epoch: 0 });
  await blocked;
  let captured;
  const allCaptured = new Promise(resolve => { captured = resolve; });
  let origins = 0;
  hooks.afterGet = keys => {
    if (keys.length === 1 && keys[0] === 'foldnex_reset_epoch' && ++origins === 7) {
      hooks.afterGet = null;
      captured();
    }
  };
  const pending = [
    worker.TabLabelCache.store(new Map([[2, 'dev']]), fingerprintById, 'openai'),
    worker.PlanMemory.putNames([{ k: ['cat:dev'], n: 'Old Name' }]),
    worker.PlanMemory.putAdvice({ 'cat:games': 'cat:video' }),
    worker.PlanMemory.recordUserRename({ tabs, name: 'Old Rename' }),
    worker.LearningCache.learnGroupRename(tabs, 'Old Preference', 'red'),
    worker.ExactResultCache.put(context, groups),
    worker.WindowPlanStore.put(7, { groups })
  ];
  await allCaptured;
  await options.LearningCache.resetRules();
  release();
  await Promise.all([first, ...pending]);
  assert.equal((await options.TabLabelCache.lookup(tabs)).labels.size, 0);
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
  const { fingerprintById } = await TabLabelCache.lookup(tabs);
  const originalSet = chrome.storage.local.set;
  chrome.storage.local.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
  await assert.rejects(TabLabelCache.store(new Map([[1, 'dev']]), fingerprintById, 'openai'), /quota/);
  chrome.storage.local.set = originalSet;

  await TabLabelCache.store(new Map([[1, 'dev']]), fingerprintById, 'openai');
  assert.equal((await TabLabelCache.lookup(tabs)).labels.get(1).c, 'dev');
  await TabLabelCache.clear();
  assert.equal((await TabLabelCache.lookup(tabs)).labels.size, 0);
});
