import assert from 'node:assert/strict';
import test from 'node:test';

import { groupCeiling } from '../src/ai-engine.js';
import {
  categoryFromSite,
  categoryFromTitle,
  enforceGroupCeiling,
  ensureUniqueNames,
  groupTokenHashes,
  mergedName,
  shortOf,
  titleTokens,
  transferNames,
  validateGroupName
} from '../src/planner.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function assertCoverage(groups, ids) {
  const placed = groups.flatMap(group => group.tabIds);
  assert.equal(placed.length, ids.length, 'every tab is placed once');
  assert.deepEqual([...placed].sort((a, b) => a - b), [...ids].sort((a, b) => a - b));
}

// ---------------------------------------------------------------------------
// Ceiling
// ---------------------------------------------------------------------------

test('planner: groupCeiling follows the preferred-count table', () => {
  const table = [
    [0, 0], [1, 0], [2, 1], [3, 1], [4, 2], [5, 2], [6, 3], [8, 4], [12, 4], [13, 5],
    [18, 6], [24, 6], [25, 7], [31, 7], [32, 8], [40, 8], [41, 9], [49, 9], [50, 10], [300, 10]
  ];
  for (const [n, expected] of table) assert.equal(groupCeiling(n), expected, `groupCeiling(${n})`);

  let previous = 0;
  for (let n = 2; n <= 1000; n++) {
    const value = groupCeiling(n);
    assert.ok(value >= previous, `monotone at ${n}`);
    assert.ok(value <= 10, `at most 10 at ${n}`);
    assert.ok(value <= Math.floor(n / 2), `at most n/2 at ${n}`);
    previous = value;
  }
});

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

test('planner, naming: merged names, regional fallback, uniqueness and validation', () => {
  assert.equal(mergedName({ name: 'Docs & Planning', size: 7 }, { name: 'Accounts & Admin', size: 5 }), 'Docs & Admin');
  assert.equal(mergedName({ name: 'Coding', size: 8 }, { name: 'AI Tools', size: 2 }), 'Code & AI');
  assert.equal(mergedName({ name: 'AI Tools', tabIds: [1, 2] }, { name: 'Coding', tabIds: [3, 4, 5, 6, 7] }), 'Code & AI');
  assert.equal(mergedName({ name: 'Code & AI', size: 10 }, { name: 'Cloud & Servers', size: 1 }), 'Code & AI & Cloud');
  assert.equal(mergedName({ name: 'Travel', size: 3 }, { name: 'Travel', size: 3 }), 'Travel');
  assert.equal(shortOf('Watch & Listen'), 'Media');
  assert.equal(shortOf('Japan & Food'), 'Japan');
  assert.equal(shortOf('Japan Trip'), 'Japan Trip');

  const tabsById = new Map([
    [1, { id: 1, url: 'https://www.booking.com/a' }],
    [2, { id: 2, url: 'https://www.booking.com/b' }],
    [3, { id: 3, url: 'https://www.airbnb.com/c' }],
    [4, { id: 4, url: 'https://www.airbnb.com/d' }],
    [5, { id: 5, url: 'https://www.airbnb.com/e' }],
    [9, { id: 9, url: 'https://x.com/a' }],
    [10, { id: 10, url: 'https://example.org/' }]
  ]);
  const unique = ensureUniqueNames([
    { name: 'Socials', kind: 'social', locked: true, tabIds: [9] },
    { name: 'Travel', key: 'cat:travel', tabIds: [3, 4, 5] },
    { name: 'travel', key: 'task:1', tabIds: [1, 2] },
    { name: 'socials', key: 'task:2', tabIds: [10] }
  ], [], { tabsById });
  assert.deepEqual(unique.map(group => [group.name, group.tabIds]), [
    ['Socials', [9, 10]],
    ['Travel', [3, 4, 5]],
    ['travel · Booking', [1, 2]]
  ]);
  const numbered = ensureUniqueNames([
    { name: 'Travel', key: 'a', tabIds: [1, 2, 3] },
    { name: 'Travel', key: 'b', tabIds: [4] }
  ]);
  assert.deepEqual(numbered.map(group => group.name), ['Travel', 'Travel 2']);

  const polishGroup = { tabIds: [1, 2] };
  const polishTabs = new Map([
    [1, { id: 1, url: 'https://www.gov.pl/web/gov' }],
    [2, { id: 2, url: 'https://www.gov.it/' }]
  ]);
  assert.equal(validateGroupName('Other'), null);
  assert.equal(validateGroupName('Misc'), null);
  assert.equal(validateGroupName('example.com'), null);
  assert.equal(validateGroupName('A very long folder name that keeps going on and on'), null);
  assert.equal(validateGroupName('Review Later'), null);
  assert.equal(validateGroupName('One Two Three Four Five'), null);
  assert.equal(validateGroupName('Southern Europe', polishGroup, polishTabs), null);
  assert.equal(validateGroupName('Travel', null, null, ['Coding', 'travel']), null);
  assert.equal(validateGroupName('Japan Trip'), 'Japan Trip');
  assert.equal(validateGroupName('Küche'), 'Küche');
  assert.equal(validateGroupName('  Japan   Trip ✈️ '), 'Japan Trip');
  assert.equal(validateGroupName('Ｋüche'), 'Küche', 'NFKC folds full-width letters');
});

test('planner, validateGroupName: vague and decorative model names keep the category name', () => {
  for (const vague of ['Technology', 'Tech', 'Online Stores', 'Online Services', 'Web Tools', 'Sites & Links', 'Culinary Delights', 'Travel Adventures']) {
    assert.equal(validateGroupName(vague), null, vague);
  }
  for (const plain of ['Productivity Tools', 'AI Tools', 'World News', 'Sports Highlights', 'Space Exploration', 'Food & Recipes']) {
    assert.equal(validateGroupName(plain), plain, plain);
  }
});

test('planner, transferNames: a user name outranks the generic-name rules', () => {
  const group = {
    name: 'Docs & Planning', key: 'cat:office', keys: ['cat:office'], kind: 'category', color: 'blue',
    tabIds: [1, 2, 3, 4, 5, 6], nameSource: 'deterministic'
  };
  const other = { name: 'Travel', key: 'cat:travel', keys: ['cat:travel'], kind: 'category', tabIds: [7, 8] };
  const tabsById = new Map([1, 2, 3, 4, 5, 6].map(id => [id, { id, url: `https://docs${id}.example.fr/`, title: 'Plan' }]));
  const fingerprintById = new Map([1, 2, 3, 4, 5, 6].map(id => [id, `f${id}`]));
  const user = n => ({ names: [{ k: [], w: [], f: ['f1', 'f2', 'f3', 'f4', 'f5'], n, c: 'red', s: 'user', t: 10 }] });
  const nameFor = n => transferNames([group, other], user(n), { tabsById, fingerprintById })[0];

  for (const [raw, expected] of [
    ['Work', 'Work'],
    ['Research', 'Research'],
    ['My Big Client Project Folder', 'My Big Client Project Folder'],
    ['Q3 🚀 Launch', 'Q3 🚀 Launch'],
    ['Japan Trip', 'Japan Trip'],
    ['Client Phoenix – Q3 planning docs', 'Client Phoenix – Q3 planning']
  ]) {
    const named = nameFor(raw);
    assert.equal(named.name, expected, raw);
    assert.equal(named.nameSource, 'memory-user', raw);
    assert.equal(named.color, 'red', raw);
  }
  for (const raw of ['   ', 'Review Later', 'travel']) {
    const kept = nameFor(raw);
    assert.equal(kept.name, 'Docs & Planning', `${raw} is not applied`);
    assert.equal(kept.nameSource, 'deterministic');
  }

  // Model names still go through validateGroupName.
  const model = { names: [{ k: ['cat:office'], w: [], n: 'Work', s: 'cloud', t: 10 }] };
  assert.equal(transferNames([group], model, { tabsById, tokensById: new Map() })[0].name, 'Docs & Planning');
});

test('planner, transferNames: user renames stick, drifted model names do not', () => {
  const group = {
    name: 'Travel', key: 'cat:travel', keys: ['cat:travel'], kind: 'category', color: 'blue',
    tabIds: [1, 2, 3, 4, 5, 6], nameSource: 'deterministic'
  };
  const fingerprintById = new Map([1, 2, 3, 4, 5, 6].map(id => [id, `f${id}`]));
  const userMemory = {
    names: [{ k: ['cat:travel'], w: [], f: ['f1', 'f2', 'f3', 'f4', 'f-closed'], n: 'Japan Trip', c: 'red', s: 'user', t: 10 }]
  };
  const [renamed] = transferNames([group], userMemory, { fingerprintById });
  assert.equal(renamed.name, 'Japan Trip');
  assert.equal(renamed.nameSource, 'memory-user');
  assert.equal(renamed.color, 'red');
  assert.equal(group.name, 'Travel', 'input is not mutated');

  const japanTabs = new Map([
    [11, { id: 11, url: 'https://a.example/', title: 'Kyoto temples in autumn' }],
    [12, { id: 12, url: 'https://b.example/', title: 'Kyoto ryokan booking' }],
    [13, { id: 13, url: 'https://c.example/', title: 'Japanese rail pass Kyoto' }]
  ]);
  const japanTokens = new Map([...japanTabs].map(([id, tab]) => [id, titleTokens(tab)]));
  const modelRecord = {
    k: ['cat:travel'], w: groupTokenHashes({ tabIds: [11, 12, 13] }, japanTokens), n: 'Japan Trip', s: 'cloud', t: 20
  };
  assert.ok(modelRecord.w.length > 0 && modelRecord.w.every(hash => /^[0-9a-f]{8}$/.test(hash)));

  const parisTabs = new Map([
    [21, { id: 21, url: 'https://d.example/', title: 'Paris museum pass' }],
    [22, { id: 22, url: 'https://e.example/', title: 'Louvre opening hours Paris' }],
    [23, { id: 23, url: 'https://f.example/', title: 'Montmartre walking tour' }]
  ]);
  const parisGroup = { ...group, tabIds: [21, 22, 23] };
  const [paris] = transferNames([parisGroup], { names: [modelRecord] }, { tabsById: parisTabs });
  assert.equal(paris.name, 'Travel');
  assert.equal(paris.nameSource, 'deterministic');

  const japanGroup = { ...group, tabIds: [11, 12, 13] };
  const [japan] = transferNames([japanGroup], { names: [modelRecord] }, { tabsById: japanTabs, tokensById: japanTokens });
  assert.equal(japan.name, 'Japan Trip');
  assert.equal(japan.nameSource, 'memory-model');

  const [lockedGroup] = transferNames([{ ...group, kind: 'social', locked: true, name: 'Socials' }], userMemory, { fingerprintById });
  assert.equal(lockedGroup.name, 'Socials', 'locked names never change');
});

// ---------------------------------------------------------------------------
// The safety net
// ---------------------------------------------------------------------------

test('planner, final safety: a dominant category cannot bridge unrelated members or overwrite a user name', () => {
  const groups = [
    { name: 'Design & Business', key: 'cat:design', keys: ['cat:design', 'cat:biz'], dominant: 'design', tabIds: [1, 2] },
    { name: 'Coding', key: 'cat:dev', keys: ['cat:dev'], dominant: 'dev', tabIds: [3, 4] },
    { name: 'My workspace', key: 'user', dominant: 'dev', tabIds: [5], nameSource: 'memory-user' }
  ];
  const result = enforceGroupCeiling(groups, { ceiling: 1 });
  assert.equal(result.length, 3);
  assert.deepEqual(result.find(group => group.nameSource === 'memory-user').tabIds, [5]);
  assert.equal(result.find(group => group.nameSource === 'memory-user').name, 'My workspace');
  const overflow = enforceGroupCeiling(Array.from({ length: 12 }, (_, i) => ({
    name: `Site ${i}`, key: `site:${i}`, tabIds: [i + 1]
  })), { ceiling: 4 });
  assert.equal(overflow.length, 10);
  assert.equal(overflow.find(group => group.kind === 'review').tabIds.length, 3);
  assertCoverage(overflow, Array.from({ length: 12 }, (_, i) => i + 1));
});

test('planner, names: model and remembered fixed-category names cannot hide mixed subjects', () => {
  const mixed = { name: 'Code & AI', kind: 'folder', keys: ['cat:dev', 'cat:ai'], dominant: 'dev', tabIds: [1, 2] };
  assert.equal(validateGroupName('Coding', mixed), null);
  assert.equal(validateGroupName('AI Tools', mixed), null);
  assert.equal(validateGroupName('Project Atlas', mixed), 'Project Atlas');
  assert.equal(validateGroupName('Coding', { ...mixed, kind: 'task' }), 'Coding', 'shared-task evidence permits its task name');
  const [remembered] = transferNames([mixed], { names: [{ n: 'Coding', k: mixed.keys, w: [], s: 'cloud' }] });
  assert.equal(remembered.name, 'Code & AI');
});

test('planner, enforceGroupCeiling: 25 groups over 120 tabs become at most 10', () => {
  let nextId = 1;
  const make = (name, count, extra = {}) => ({ name, color: 'blue', tabIds: Array.from({ length: count }, () => nextId++), ...extra });
  const categories = [
    ['dev', 'Coding', 10], ['ai', 'AI Tools', 1], ['design', 'Design', 4], ['office', 'Docs & Planning', 5],
    ['biz', 'Business', 4], ['jobs', 'Jobs', 3], ['learn', 'Learning', 6], ['news', 'News', 7],
    ['video', 'Watch & Listen', 6], ['shop', 'Shopping', 6], ['travel', 'Travel', 8], ['food', 'Food & Recipes', 7],
    ['home', 'Home', 4], ['health', 'Health', 3], ['cars', 'Cars', 3], ['admin', 'Accounts & Admin', 5]
  ];
  const groups = [
    make('Socials', 5, { kind: 'social', locked: true }),
    make('Home Lab', 3),
    ...categories.map(([key, name, count]) => make(name, count, { dominant: key, key: `cat:${key}` })),
    ...[['Japan Trip', 5], ['Project Atlas', 5], ['Garden Plans', 4], ['Wedding', 4], ['Tax Year', 4], ['Moving House', 4], ['Book Club', 4]]
      .map(([name, count]) => make(name, count))
  ];
  assert.equal(groups.length, 25);
  const allIds = groups.flatMap(group => group.tabIds);
  assert.equal(allIds.length, 120);

  const run = () => enforceGroupCeiling(groups, { ceiling: 10, protectedNames: ['Home Lab'] });
  const result = run();
  assert.deepEqual(run(), result, 'identical across runs');
  assert.ok(result.length <= 10);
  assertCoverage(result, allIds);
  assert.deepEqual(result.find(group => group.name === 'Socials').tabIds, groups[0].tabIds);
  assert.deepEqual(result.find(group => group.name === 'Home Lab').tabIds, groups[1].tabIds);
  const aiTab = groups.find(group => group.name === 'AI Tools').tabIds[0];
  const devTab = groups.find(group => group.name === 'Coding').tabIds[0];
  assert.ok(result.find(group => group.tabIds.includes(aiTab)).tabIds.includes(devTab), 'the smallest group joins its affinity partner');
  assert.ok(result.every(group => group.name && group.name.length <= 30 && group.name !== 'Other'));

  // No-op when the plan already fits.
  const fitting = groups.slice(0, 5);
  assert.deepEqual(enforceGroupCeiling(fitting, { ceiling: 10 }), fitting);

  // dominantOf supplies categories for groups that carry none.
  const custom = enforceGroupCeiling([
    { name: 'A', tabIds: [1, 2, 3] },
    { name: 'B', tabIds: [4] },
    { name: 'C', tabIds: [5, 6] }
  ], { ceiling: 2, dominantOf: group => ({ A: 'dev', B: 'ai', C: 'food' })[group.name] });
  assert.deepEqual(custom.map(group => [group.name, group.tabIds]), [['Code & AI', [1, 2, 3, 4]], ['C', [5, 6]]]);
});

// ---------------------------------------------------------------------------
// Category and tokens
// ---------------------------------------------------------------------------

test('planner, category from site and title, and title tokens', () => {
  const expected = [
    ['https://en.wikipedia.org/wiki/Photosynthesis', 'learn'],
    ['https://github.com/org/repo', 'dev'],
    ['https://mail.google.com/mail/u/0/', 'mail'],
    ['https://www.booking.com/', 'travel'],
    ['https://www.bbc.co.uk/news', 'news'],
    ['https://medium.com/@someone/post', 'read'],
    ['https://www.google.com/search?q=x', null],
    ['https://www.google.com/maps/place/x', 'travel'],
    ['https://www.gov.pl/', 'admin'],
    ['https://www.tesla.com/', 'cars'],
    ['https://unknown-site.example/', null],
    ['not a url', null]
  ];
  for (const [url, key] of expected) assert.equal(categoryFromSite(url), key, url);

  assert.equal(categoryFromTitle('Beste Rezept für Kuchen'), 'food');
  assert.equal(categoryFromTitle('Cheap flights to Rome'), 'travel');
  assert.equal(categoryFromTitle('簡単レシピ'), 'food', 'CJK words are segmented without spaces');
  assert.equal(categoryFromTitle('Quarterly planning notes'), 'office');
  assert.equal(categoryFromTitle(''), null);

  const tokens = tab => [...titleTokens(tab)].sort();
  assert.deepEqual(tokens({ url: 'https://en.wikipedia.org/wiki/P', title: 'Photosynthesis in plants - Wikipedia' }), ['photosynthesi', 'plant']);
  assert.deepEqual(tokens({ url: 'https://de.wikipedia.org/wiki/Q', title: 'Quantenmechanik und Relativität – Wikipedia' }), ['quantenmechanik', 'relativität']);
  assert.deepEqual(tokens({ url: 'https://blog.example/', title: 'The best guide to Japanese temples for 2026' }), ['japan', 'temple']);
  assert.deepEqual(tokens({ url: 'https://github.com/rust-lang/rust', title: 'GitHub Actions for Rust' }), ['action', 'rust']);
  assert.deepEqual(tokens({ url: 'https://cookpad.com/jp', title: '寿司の作り方' }), ['作り方', '寿司']);
  assert.deepEqual(tokens({ url: 'https://ko.wikipedia.org/', title: '한글 - 위키백과' }), ['위키백과', '한글']);
});

test('planner, tokens: numbers and version strings are never title tokens', () => {
  const tokens = title => [...titleTokens({ url: 'https://blog.example/', title })].sort();
  assert.deepEqual(tokens('iOS 18.1 hands-on'), ['hand', 'ios']);
  assert.deepEqual(tokens('Python 3.13 changelog'), ['changelog', 'python']);
  assert.deepEqual(tokens('Laptop £1,299 or 19.99 monthly'), ['laptop', 'monthly']);
  assert.deepEqual(tokens('Release v2.0.1 and v10 changelog'), ['changelog', 'release']);
  assert.deepEqual(tokens('ES2015 x86 mp3 player'), ['es2015', 'mp3', 'player', 'x86']);

});

test('planner, transferNames set match: a rename tied between two cached groups names neither', () => {
  const groups = [
    { name: 'Alpha', key: 'a', tabIds: [1, 2], nameSource: 'model' },
    { name: 'Beta', key: 'b', tabIds: [3, 4], nameSource: 'model' }
  ];
  const fingerprintById = new Map([1, 2, 3, 4].map(id => [id, `f${id}`]));
  const memory = { names: [{ k: [], w: [], f: ['f1', 'f2', 'f3', 'f4'], n: 'Both Halves', c: 'red', s: 'user', t: 1 }] };
  const out = transferNames(groups, memory, { fingerprintById, userMatch: 'set' });
  assert.deepEqual(out.map(group => group.name), ['Alpha', 'Beta']);
});

test('planner, transferNames set match: a record that loses its best group does not fall through to a weaker one', () => {
  const groups = [
    { name: 'Coding', key: 'c', tabIds: [1, 2, 3, 4], nameSource: 'model' },
    { name: 'Travel', key: 't', tabIds: [5, 6, 7], nameSource: 'model' }
  ];
  const fingerprintById = new Map([1, 2, 3, 4, 5, 6, 7].map(id => [id, `f${id}`]));
  const memory = { names: [
    // Exact coding cohort: takes Coding.
    { k: [], w: [], f: ['f1', 'f2', 'f3', 'f4'], n: 'Side Project', c: 'blue', s: 'user', t: 2 },
    // Best on Coding too (3 of 4); it also covers Travel by 2 of 3, which must not be used.
    { k: [], w: [], f: ['f1', 'f2', 'f3', 'f5', 'f6'], n: 'Tokyo Itinerary', c: 'pink', s: 'user', t: 1 }
  ] };
  const out = transferNames(groups, memory, { fingerprintById, userMatch: 'set' });
  assert.deepEqual(out.map(group => group.name), ['Side Project', 'Travel']);
});

test('planner, transferNames set match: exactly half of the smaller side is not enough', () => {
  const groups = [{ name: 'Coding', key: 'c', tabIds: [1, 2, 3, 4, 5, 6], nameSource: 'model' }];
  const fingerprintById = new Map([1, 2, 3, 4, 5, 6].map(id => [id, `f${id}`]));
  const memory = { names: [{ k: [], w: [], f: ['f1', 'f2', 'f3', 'f9', 'f10', 'f11', 'f12', 'f13'], n: 'Tokyo Itinerary', c: 'pink', s: 'user', t: 1 }] };
  const out = transferNames(groups, memory, { fingerprintById, userMatch: 'set' });
  assert.deepEqual(out.map(group => group.name), ['Coding']);
});
