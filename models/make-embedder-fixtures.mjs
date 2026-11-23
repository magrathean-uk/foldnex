// Regenerates test/fixtures/embedder-reference.json and embedder-window.json.
// Lives here, not in test/, so `node --test` does not run it.
//   node models/make-embedder-fixtures.mjs <potion-base-4M model dir> <python with tokenizers and numpy>
// Reference vectors come from embedder-reference.py, Python following model2vec's
// encode (plain mean over title tokens, unit length); the window vectors from the float prototype in eval/lib.mjs
// converted to int8 (idf on, centring off). Both are rounded to keep the files small.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embed, loadModel, toInt8 } from '../eval/lib.mjs';
import { TEXTS } from '../eval/local-refcheck.mjs';

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const [modelDir, python] = process.argv.slice(2);
if (!modelDir || !python) {
  console.error('Usage: node models/make-embedder-fixtures.mjs <model dir> <python with tokenizers and numpy>');
  process.exit(2);
}
const round = (values, places) => Array.from(values, value => Number(value.toFixed(places)));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foldnex-embedder-'));
fs.writeFileSync(path.join(tmp, 'texts.json'), JSON.stringify(TEXTS));
execFileSync(python, ['-I', path.join(HERE, 'embedder-reference.py'), modelDir, path.join(tmp, 'texts.json'), path.join(tmp, 'ref.json')], { stdio: 'inherit' });
const ref = JSON.parse(fs.readFileSync(path.join(tmp, 'ref.json'), 'utf8'));
fs.rmSync(tmp, { recursive: true, force: true });
fs.writeFileSync(path.join(HERE, 'embedder-reference.json'), JSON.stringify({
  model: 'minishlab/potion-base-4M; embedder-reference.py (tokenizers + numpy, model2vec encode semantics)',
  texts: TEXTS,
  ids: ref.ids,
  vectors: ref.vectors.map(vector => round(vector, 4))
}));

const PAIRS = [
  ['GitHub - northwind-labs/tabsort: Tab organiser for Chrome', 'github northwind labs tabsort'],
  ['Pull requests · northwind-labs/tabsort', 'github northwind labs tabsort pull'],
  ['How To Set Up WireGuard on Ubuntu 24.04 | DigitalOcean', 'digitalocean community tutorials wireguard ubuntu'],
  ['WireGuard Quick Start', 'wireguard quickstart'],
  ['Café crème brûlée recipe — easy, 30 minutes', 'bbcgoodfood recipes creme brulee'],
  ['Easy Sunday roast chicken dinner recipe', 'bbcgoodfood recipes roast chicken'],
  ['Premier League table 2026/27 - BBC Sport', 'bbc sport football tables'],
  ['Arsenal v Chelsea: live match report', 'bbc sport football live arsenal chelsea'],
  ['Sony WH-1000XM6 Wireless Headphones : Electronics', 'amazon sony headphones'],
  ['Best noise cancelling headphones 2026 reviewed', 'rtings headphones best noise cancelling'],
  ['Inbox (1,204) - user@gmail.com - Gmail', 'mail google mail'],
  ['TypeError: Cannot read properties of undefined (reading map)', 'stackoverflow questions typeerror undefined map'],
  ['東京の天気 - Yahoo!天気・災害', 'weather yahoo tokyo'],
  ['Straße und Fußgängerzone in München: Öffnungszeiten', ''],
  ['qzxvbwplk frobnicator', ''],
  ['', 'example']
];
const model = toInt8(loadModel(path.dirname(path.resolve(modelDir)), path.basename(path.resolve(modelDir))));
const vectors = embed(model, PAIRS, { idf: true, center: false });
fs.writeFileSync(path.join(HERE, 'embedder-window.json'), JSON.stringify({
  note: 'eval/lib.mjs embed(toInt8(loadModel), pairs, {idf: true, center: false}), rounded to 7 places',
  pairs: PAIRS,
  vectors: vectors.map(vector => round(vector, 7))
}));
console.log(`wrote fixtures for ${TEXTS.length} texts and ${PAIRS.length} window pairs`);
