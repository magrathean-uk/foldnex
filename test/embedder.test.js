import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { embedWindow, loadTable, parseTable, resetTableCache, tokenIds, urlWords } from '../src/embedder.js';

const ROOT = new URL('../', import.meta.url);
const bytes = await readFile(new URL('models/potion-base-4M.int8.bin', ROOT));
const manifest = JSON.parse(await readFile(new URL('models/potion-base-4M.json', ROOT), 'utf8'));
const reference = JSON.parse(await readFile(new URL('test/fixtures/embedder-reference.json', ROOT), 'utf8'));
const windowFixture = JSON.parse(await readFile(new URL('test/fixtures/embedder-window.json', ROOT), 'utf8'));
const arrayBuffer = () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const table = parseTable(arrayBuffer());

// Words over 40 characters are unknown by design (a work bound); the Python
// reference has no such cut, so those texts are compared separately.
const overlong = text => /\S{41}/u.test(text);
const cosine = (a, b) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let d = 0; d < a.length; d++) {
    dot += a[d] * b[d];
    na += a[d] * a[d];
    nb += b[d] * b[d];
  }
  return na === 0 && nb === 0 ? 1 : dot / Math.sqrt(na * nb || 1);
};

test('the committed table matches its manifest and the licence file is packaged beside it', async () => {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256);
  assert.equal(bytes.length, manifest.bytes);
  assert.equal(table.dim, manifest.dimension);
  assert.equal(table.rows, manifest.rows);
  assert.equal(table.version, manifest.formatVersion);
  const licence = await readFile(new URL(`models/${manifest.source.licenceFile}`, ROOT));
  assert.equal(createHash('sha256').update(licence).digest('hex'), manifest.source.licenceFileSha256);
  assert.match(licence.toString('utf8'), /Permission is hereby granted, free of charge/);
});

test('parseTable rejects damaged input with a clear error', () => {
  const copy = () => new Uint8Array(arrayBuffer());
  const badMagic = copy();
  badMagic[0] = 0x58;
  assert.throws(() => parseTable(badMagic.buffer), /wrong magic/);

  const badVersion = copy();
  new DataView(badVersion.buffer).setUint32(4, 2, true);
  assert.throws(() => parseTable(badVersion.buffer), /format version 2/);

  assert.throws(() => parseTable(arrayBuffer().slice(0, bytes.length - 1)), /length/);
  assert.throws(() => parseTable(new Uint8Array([...copy(), 0]).buffer), /length/);
  assert.throws(() => parseTable(arrayBuffer().slice(0, 10)), /too short/);
  assert.throws(() => parseTable(new ArrayBuffer(0)), /too short/);
  assert.throws(() => parseTable('not a buffer'), /ArrayBuffer/);

  const noRows = copy();
  new DataView(noRows.buffer).setUint32(12, 0, true);
  assert.throws(() => parseTable(noRows.buffer), /implausible/);

  const brokenSettings = copy();
  brokenSettings[24] = 0xff;
  assert.throws(() => parseTable(brokenSettings.buffer), /not valid/);

  const shortVocab = copy();
  new DataView(shortVocab.buffer).setUint32(12, table.rows - 1, true);
  assert.throws(() => parseTable(shortVocab.buffer), /length/);
});

test('token ids match the Python reference on every reference text', () => {
  assert.equal(reference.texts.length, 50);
  reference.texts.forEach((text, i) => {
    if (overlong(text)) return;
    assert.deepEqual(tokenIds(table, text), reference.ids[i], `ids for ${JSON.stringify(text).slice(0, 60)}`);
  });
  const long = reference.texts.findIndex(text => text.startsWith('Pneumono'));
  assert.deepEqual(tokenIds(table, reference.texts[long]), tokenIds(table, 'explained'));
});

test('token ids match the prototype on the float model when it is available', async t => {
  // FOLDNEX_MODEL_DIR: a local copy of minishlab/potion-base-4M (see eval/README.md).
  const modelDir = process.env.FOLDNEX_MODEL_DIR || '';
  if (!modelDir || !fs.existsSync(`${modelDir}/model.safetensors`)) {
    t.skip('model directory not available');
    return;
  }
  const { loadModel, tokenIds: prototypeIds } = await import('../eval/lib.mjs');
  const model = loadModel(modelDir.replace(/\/[^/]+$/, ''), modelDir.replace(/^.*\//, ''));
  for (const text of reference.texts.filter(text => !overlong(text))) assert.deepEqual(tokenIds(table, text), prototypeIds(model, text), JSON.stringify(text).slice(0, 60));
});

test('plain-mean vectors have cosine of at least 0.99 to the Python reference', () => {
  const vectors = embedWindow(table, reference.texts.map(text => [text, '']), { idf: false });
  const cosines = vectors.map((vector, i) => (overlong(reference.texts[i]) ? 1 : cosine(vector, reference.vectors[i])));
  const worst = Math.min(...cosines);
  const mean = cosines.reduce((sum, value) => sum + value, 0) / cosines.length;
  console.log(`reference cosine over ${cosines.length} texts: min ${worst.toFixed(6)} (${JSON.stringify(reference.texts[cosines.indexOf(worst)]).slice(0, 40)}), mean ${mean.toFixed(6)}`);
  cosines.forEach((value, i) => assert.ok(value >= 0.99, `cosine ${value} for ${JSON.stringify(reference.texts[i]).slice(0, 60)}`));
});

test('embedWindow with idf gives unit vectors and matches the prototype on a fixture window', () => {
  const vectors = embedWindow(table, windowFixture.pairs, { idf: true });
  assert.equal(vectors.length, windowFixture.pairs.length);
  vectors.forEach((vector, i) => {
    assert.ok(vector instanceof Float32Array);
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    const expected = windowFixture.vectors[i];
    if (expected.every(value => value === 0)) {
      assert.equal(norm, 0, `pair ${i} has no known token and gives the zero vector`);
    } else {
      assert.ok(Math.abs(norm - 1) < 1e-6, `pair ${i} norm ${norm}`);
    }
    vector.forEach((value, d) => assert.ok(Math.abs(value - expected[d]) < 1e-5, `pair ${i} dim ${d}: ${value} vs ${expected[d]}`));
  });
  assert.deepEqual(embedWindow(table, []), []);
});

test('urlWords keeps host and path words and drops noise', () => {
  assert.equal(urlWords('https://www.example.co.uk/path/to/page.html?query=1#frag'), 'example path to page');
  assert.equal(urlWords('https://github.com/northwind-labs/tabsort/pull/12345'), 'github northwind labs tabsort pull');
  assert.equal(urlWords('not a url'), '');
});

test('loadTable returns null when the read fails or the file is damaged, and retries later', async () => {
  resetTableCache();
  assert.equal(await loadTable({ read: async () => { throw new Error('offline'); } }), null);
  assert.equal(await loadTable({ read: async () => new ArrayBuffer(100) }), null);
  assert.equal(await loadTable(), null, 'outside the extension there is no chrome.runtime to read from');
  const loaded = await loadTable({ read: async () => arrayBuffer() });
  assert.equal(loaded.rows, table.rows);
  resetTableCache();
});

test('concurrent loadTable calls share one read, and the table is cached afterwards', async () => {
  resetTableCache();
  let reads = 0;
  const read = async () => {
    reads++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return arrayBuffer();
  };
  const [a, b, c] = await Promise.all([loadTable({ read }), loadTable({ read }), loadTable({ read })]);
  assert.equal(reads, 1);
  assert.ok(a && a === b && b === c);
  assert.equal(await loadTable({ read }), a);
  assert.equal(reads, 1);
  resetTableCache();
});

test('parsing and embedding stay fast', () => {
  const buffer = arrayBuffer();
  parseTable(buffer); // warm up
  const parseStart = performance.now();
  parseTable(buffer);
  const parseMs = performance.now() - parseStart;

  const pairs = Array.from({ length: 200 }, (_, i) => [`${reference.texts[i % 50]} ${i}`, 'github northwind labs']);
  const embedStart = performance.now();
  embedWindow(table, pairs);
  const embedMs = performance.now() - embedStart;
  console.log(`parse ${parseMs.toFixed(1)} ms, embed 200 titles ${embedMs.toFixed(1)} ms`);
  assert.ok(parseMs < 500, `parse took ${parseMs} ms`);
  assert.ok(embedMs < 500, `embed took ${embedMs} ms`);
});

test('a hostile window of very long titles and words finishes its local result quickly', async () => {
  const { planLocally } = await import('../src/local-engine.js');
  const junk = ('a'.repeat(100) + ' ').repeat(40);
  const tabs = Array.from({ length: 200 }, (_, i) => ({
    id: i + 1, windowId: 1, index: i, title: `${i % 2 ? 'Telescope' : 'Sourdough'} ${junk}`, url: `https://www.site-${i}.com/p/${i}`
  }));
  const startedAt = performance.now();
  const rows = embedWindow(table, tabs.map(tab => [tab.title, urlWords(tab.url)]), { idf: true, urlWeight: 0.5 });
  planLocally(tabs, { vectors: new Map(tabs.map((tab, i) => [tab.id, rows[i]])) });
  const took = performance.now() - startedAt;
  // Typically under 50 ms; the unbounded form took seconds. The margin is wide so a loaded machine does not fail it.
  assert.ok(took < 1500, `local result took ${took.toFixed(0)} ms`);
});

test('tokenIds cuts a text to 64 tokens and treats a word over 40 characters as unknown', () => {
  assert.equal(tokenIds(table, 'go '.repeat(100)).length, 64);
  assert.deepEqual(tokenIds(table, `${'telescope'.repeat(5)} sourdough`), tokenIds(table, 'sourdough'));
});

test('parseTable rejects non-finite scales and out-of-range tokeniser settings', () => {
  const copy = () => new Uint8Array(arrayBuffer());
  const view = new DataView(arrayBuffer());
  const settingsLength = view.getUint32(16, true);
  const vocabLength = view.getUint32(20, true);
  const scalesStart = (24 + settingsLength + vocabLength + 3) & ~3;
  const nan = copy();
  new DataView(nan.buffer).setFloat32(scalesStart + 8, NaN, true);
  assert.throws(() => parseTable(nan.buffer), /scale/);
  const negative = copy();
  new DataView(negative.buffer).setFloat32(scalesStart + 8, -1, true);
  assert.throws(() => parseTable(negative.buffer), /scale/);

  const settings = JSON.parse(new TextDecoder().decode(bytes.subarray(24, 24 + settingsLength)));
  const withSettings = patch => {
    const json = new TextEncoder().encode(JSON.stringify({ ...settings, normalize: undefined, ...patch }).padEnd(settingsLength, ' '));
    assert.equal(json.length, settingsLength);
    const out = copy();
    out.set(json, 24);
    return out.buffer;
  };
  assert.doesNotThrow(() => parseTable(withSettings({})));
  assert.throws(() => parseTable(withSettings({ maxInputCharsPerWord: 9e9 })), /maxInputCharsPerWord/);
  assert.throws(() => parseTable(withSettings({ maxInputCharsPerWord: 0 })), /maxInputCharsPerWord/);
  assert.throws(() => parseTable(withSettings({ continuingSubwordPrefix: 'x'.repeat(17) })), /continuingSubwordPrefix/);
});

test('a word cached as unknown is a cache hit and is not searched again', () => {
  const word = `${"q".repeat(38)}\u01C2`;
  assert.equal(Array.from(word).length, 39);
  let lookups = 0;
  const vocab = table.vocab;
  const counted = { ...table, vocab: { get: key => { lookups++; return vocab.get(key); } } };
  const memo = new Map();
  assert.deepEqual(tokenIds(counted, word, memo), table.settings.dropUnknown ? [] : [table.unkId], 'the word is unknown');
  const first = lookups;
  assert.ok(first > 100, `the first search makes many lookups (${first})`);
  tokenIds(counted, `${word} ${word}`, memo);
  assert.equal(lookups, first, 'no vocabulary lookup for the cached unknown word');
});
