// Embedder check: eval/lib.mjs embed() (plain mean, title only) against the
// reference Python model2vec on 50 varied texts, for each table.
//   node eval/local-refcheck.mjs <models dir> <python with model2vec>
// Exit 1 if any cosine is below 0.99. Writes nothing to the repo.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embed, loadModel, tokenIds } from './lib.mjs';

export const MODEL_NAMES = ['potion-base-8M', 'potion-base-4M', 'potion-base-2M'];

export const TEXTS = [
  'GitHub - northwind-labs/tabsort: Tab organiser for Chrome',
  'How To Set Up WireGuard on Ubuntu 24.04 | DigitalOcean',
  'Café crème brûlée recipe — easy, 30 minutes',
  'Ελληνικά: ΟΔΗΓΟΣ ΤΑΞΙΔΙΟΥ ΣΤΗΝ ΑΘΗΝΑ ΚΑΙ ΣΤΙΣ ΣΠΕΤΣΕΣ',
  'Привет, мир! Новости Москвы сегодня',
  '東京の天気 - Yahoo!天気・災害',
  '北京烤鸭的做法 - 下厨房',
  '서울 맛집 추천 | 네이버 블로그',
  'ニュース速報：日本代表がワールドカップで勝利',
  'مرحبا بالعالم - أخبار اليوم',
  'שלום עולם - חדשות',
  'İstanbul uçak bileti, ucuz uçuşlar | Türk Hava Yolları',
  'Straße und Fußgängerzone in München: Öffnungszeiten',
  'Tiếng Việt: Hướng dẫn nấu phở bò Hà Nội',
  'Pneumonoultramicroscopicsilicovolcanoconiosis explained',
  'Supercalifragilisticexpialidociousxyzzyqwertyuiopasdfghjklzxcvbnmqwertyuiopasdfghjklzxcvbnmqwertyuiopasdfghjklz and friends',
  'qzxvbwplk frobnicator hyperdimensionalquuxifier',
  'Price: £1,299.99 (save €200!) — limited offer™ © 2026',
  '"Smart quotes" and ‘single’ quotes… plus «guillemets»',
  'C++ vs. C# vs. F#: which one? (2026 edition) [updated]',
  'user@example.com <mailto:user@example.com> #hashtag @mention',
  'https://www.example.co.uk/path/to/page.html?query=1&x=y#frag',
  'Rock 🎸 and roll 🎶 playlist 🔥🔥 best of 2025',
  'Fullwidth ＡＢＣ ｄｅｆ １２３ characters',
  'ﬁnancial ﬂow ligatures and ½ fractions ²³',
  'Zero​width​space and soft­hyphen in a title',
  '﻿Byte order mark at the start',
  'Tabs\tand\nnewlines\r\nin   the   title',
  'Non breaking spaces　everywhere',
  'Combining á è ô marks and ñ',
  'NAÏVE COÖPERATION RÉSUMÉ FAÇADE',
  'Ångström ünits: Ørsted, Æsir, Œuvre, Łódź',
  'x² + y² = z²; ∑ ∫ √ ∞ ≠ ≤ ≥',
  'Rare CJK: 𠀋𡈽𡌛 and 丂丄丅 characters',
  'kubectl get pods --all-namespaces -o wide | grep CrashLoopBackOff',
  'TypeError: Cannot read properties of undefined (reading \'map\')',
  'Premier League table 2026/27 - BBC Sport',
  'Inbox (1,204) - user@gmail.com - Gmail',
  'Amazon.co.uk: Sony WH-1000XM6 Wireless Headphones : Electronics',
  'r/LocalLLaMA - Llama 4 70B Q4_K_M benchmarks on M4 Max',
  'Ünïcödé ëvérywhérê ïn thïs tïtlé',
  'हिन्दी समाचार - आज की ताज़ा खबरें',
  'ภาษาไทย ข่าววันนี้',
  'Español: ¿Dónde está la estación? ¡Vamos!',
  'Português: Ação, coração e informação',
  'Polski: Zażółć gęślą jaźń',
  'Hello.World,Foo;Bar:Baz!Qux?Quux',
  'snake_case_identifier and camelCaseIdentifier and kebab-case-identifier',
  'v1.2.3-beta.4+build.567 release notes',
  'A'.repeat(101) + ' tail words after a very long run'
];

const HERE = path.dirname(fileURLToPath(import.meta.url));

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let d = 0; d < a.length; d++) {
    dot += a[d] * b[d];
    na += a[d] * a[d];
    nb += b[d] * b[d];
  }
  if (na === 0 && nb === 0) return 1;
  return dot / (Math.sqrt(na * nb) || 1);
}

/** Runs the reference and returns {models: {name: {worst, worstText, mean}}, idMismatches}. */
export function refCheck(modelsDir, python) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foldnex-ref-'));
  const textsPath = path.join(dir, 'texts.json');
  const outPath = path.join(dir, 'ref.json');
  fs.writeFileSync(textsPath, JSON.stringify(TEXTS));
  execFileSync(python, ['-I', path.join(HERE, 'ref-embed.py'), modelsDir, textsPath, outPath, ...MODEL_NAMES], { stdio: 'inherit' });
  const ref = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  const models = {};
  let idMismatches = [];
  MODEL_NAMES.forEach((name, index) => {
    const model = loadModel(modelsDir, name);
    if (index === 0) {
      idMismatches = TEXTS.map((text, i) => ({ text, js: tokenIds(model, text), py: ref._ids[i] }))
        .filter(row => row.js.join(',') !== row.py.join(','));
    }
    const vectors = embed(model, TEXTS.map(text => [text, '']));
    const cosines = vectors.map((vector, i) => cosine(vector, ref[name][i]));
    const worst = Math.min(...cosines);
    models[name] = { worst, worstText: TEXTS[cosines.indexOf(worst)], mean: cosines.reduce((s, v) => s + v, 0) / cosines.length };
  });
  return { texts: TEXTS.length, models, idMismatches };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [modelsDir, python = 'python3'] = process.argv.slice(2);
  if (!modelsDir) {
    console.error('Usage: node eval/local-refcheck.mjs <models dir> [python with model2vec]');
    process.exit(2);
  }
  const result = refCheck(modelsDir, python);
  for (const [name, row] of Object.entries(result.models)) {
    console.log(`${name.padEnd(16)} worst cosine ${row.worst.toFixed(6)}  mean ${row.mean.toFixed(6)}  worst text: ${JSON.stringify(row.worstText).slice(0, 60)}`);
  }
  for (const row of result.idMismatches) console.log(`token ids differ: ${JSON.stringify(row.text).slice(0, 70)}\n  js ${row.js.join(' ')}\n  py ${row.py.join(' ')}`);
  const pass = Object.values(result.models).every(row => row.worst >= 0.99);
  console.log(pass ? 'pass: every cosine >= 0.99' : 'FAIL: a cosine is below 0.99');
  process.exit(pass ? 0 : 1);
}
