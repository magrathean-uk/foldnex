#!/usr/bin/env node
// Builds the bundled embedding table from a local copy of minishlab/potion-base-4M.
//
//   node scripts/build-embedding-table.mjs <model dir> [--out models/]
//
// <model dir> holds model.safetensors, tokenizer.json and config.json. Output is
// deterministic (the same bytes on every run):
//   potion-base-4M.int8.bin   the table; the format is documented in src/embedder.js
//   potion-base-4M.json       source, checksums, sizes and the build command
// The licence text (models/potion-base-4M-LICENSE.txt) is committed by hand and only
// hashed here. The inputs must be the pinned revision: the script stops otherwise.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'potion-base-4M';
const FORMAT_VERSION = 1;
const MAGIC = 'FXEM';

const SOURCE = {
  model: 'minishlab/potion-base-4M',
  url: 'https://huggingface.co/minishlab/potion-base-4M',
  revision: '9b3cff412d30be9ae8603fe10224c224f3401869',
  licence: 'MIT',
  licenceFile: `${NAME}-LICENSE.txt`,
  licenceSource: 'https://raw.githubusercontent.com/MinishLab/model2vec/main/LICENSE'
};

// SHA-256 of the three inputs at SOURCE.revision. model.safetensors equals the
// LFS object id the Hub lists for that revision; the other two match the Hub's
// git blob ids for it.
const INPUT_SHA256 = {
  'model.safetensors': '8a7140edd17ffab30ddcff1135eda127df57abfae856203dbd7b3d061295c31a',
  'tokenizer.json': 'e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50', // gitleaks:allow (a file checksum)
  'config.json': '90a28f209637bea10a440b69c1b41b72a24c4cb7d378030172f89c671c254c80'
};

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => {
  console.error(`build-embedding-table: ${message}`);
  process.exit(1);
};

function parseArgs(argv) {
  const args = argv.slice(2);
  let modelDir = null;
  let out = 'models';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = args[++i] || fail('--out needs a directory');
    else if (!modelDir) modelDir = args[i];
    else fail(`unexpected argument ${args[i]}`);
  }
  if (!modelDir) fail('usage: node scripts/build-embedding-table.mjs <model dir> [--out models/]');
  return { modelDir, out };
}

function readSafetensors(buf) {
  const headerLength = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.subarray(8, 8 + headerLength).toString('utf8'));
  const tensor = header.embeddings;
  if (!tensor || tensor.dtype !== 'F32' || tensor.shape.length !== 2) fail('model.safetensors has no F32 "embeddings" matrix');
  const [rows, dim] = tensor.shape;
  const [start, end] = tensor.data_offsets;
  if (end - start !== rows * dim * 4) fail('embeddings byte length does not match its shape');
  const base = buf.byteOffset + 8 + headerLength + start;
  // Copy so the Float32Array is aligned whatever the Buffer's offset.
  const matrix = new Float32Array(buf.buffer.slice(base, base + (end - start)));
  return { rows, dim, matrix };
}

function tokenizerSettings(tokenizer, config) {
  const { normalizer, pre_tokenizer: pre, model } = tokenizer;
  if (normalizer?.type !== 'BertNormalizer') fail('tokenizer normalizer is not BertNormalizer');
  if (pre?.type !== 'BertPreTokenizer') fail('tokenizer pre_tokenizer is not BertPreTokenizer');
  if (model?.type !== 'WordPiece') fail('tokenizer model is not WordPiece');
  const lowercase = normalizer.lowercase !== false;
  return {
    lowercase,
    // BertNormalizer: strip_accents null follows lowercase.
    stripAccents: normalizer.strip_accents ?? lowercase,
    cleanText: normalizer.clean_text !== false,
    handleChineseChars: normalizer.handle_chinese_chars !== false,
    unknownToken: model.unk_token,
    continuingSubwordPrefix: model.continuing_subword_prefix,
    maxInputCharsPerWord: model.max_input_chars_per_word,
    // Not in tokenizer.json: model2vec leaves unknown-word ids out of the mean.
    dropUnknown: true,
    // config.json: the reference returns unit vectors.
    normalize: config.normalize === true
  };
}

function vocabList(tokenizer, rows) {
  const vocab = Object.entries(tokenizer.model.vocab);
  if (vocab.length !== rows) fail(`vocabulary has ${vocab.length} entries but the matrix has ${rows} rows`);
  const list = new Array(rows);
  for (const [token, id] of vocab) {
    if (!Number.isInteger(id) || id < 0 || id >= rows || list[id] !== undefined) fail(`vocabulary ids are not dense and unique (${token}: ${id})`);
    if (token === '' || /[\n\r]/.test(token)) fail(`token ${JSON.stringify(token)} cannot be stored one per line`);
    list[id] = token;
  }
  return list;
}

function int8Rows({ rows, dim, matrix }) {
  const q = new Int8Array(rows * dim);
  const scales = new Float32Array(rows);
  for (let row = 0; row < rows; row++) {
    let max = 0;
    for (let d = 0; d < dim; d++) max = Math.max(max, Math.abs(matrix[row * dim + d]));
    if (max === 0) continue;
    scales[row] = max / 127;
    for (let d = 0; d < dim; d++) q[row * dim + d] = Math.round(matrix[row * dim + d] / max * 127);
  }
  return { q, scales };
}

function encodeTable({ rows, dim, settings, vocab, scales, q }) {
  const settingsBytes = Buffer.from(JSON.stringify(settings), 'utf8');
  const vocabBytes = Buffer.from(vocab.join('\n'), 'utf8');
  const header = Buffer.alloc(24);
  header.write(MAGIC, 0, 'latin1');
  header.writeUInt32LE(FORMAT_VERSION, 4);
  header.writeUInt32LE(dim, 8);
  header.writeUInt32LE(rows, 12);
  header.writeUInt32LE(settingsBytes.length, 16);
  header.writeUInt32LE(vocabBytes.length, 20);
  const used = header.length + settingsBytes.length + vocabBytes.length;
  const padding = Buffer.alloc((4 - (used % 4)) % 4);
  const scaleBytes = Buffer.alloc(rows * 4);
  scales.forEach((value, i) => scaleBytes.writeFloatLE(value, i * 4));
  return Buffer.concat([header, settingsBytes, vocabBytes, padding, scaleBytes, Buffer.from(q.buffer, q.byteOffset, q.byteLength)]);
}

const { modelDir, out } = parseArgs(process.argv);
const read = file => {
  const full = path.join(modelDir, file);
  if (!fs.existsSync(full)) fail(`${full} not found`);
  return fs.readFileSync(full);
};
const inputs = Object.fromEntries(Object.keys(INPUT_SHA256).map(file => [file, read(file)]));
for (const [file, bytes] of Object.entries(inputs)) {
  const actual = sha256(bytes);
  if (actual !== INPUT_SHA256[file]) fail(`${file} is not the pinned ${SOURCE.model} revision ${SOURCE.revision.slice(0, 7)} (sha256 ${actual})`);
}

const { rows, dim, matrix } = readSafetensors(inputs['model.safetensors']);
const tokenizer = JSON.parse(inputs['tokenizer.json'].toString('utf8'));
const config = JSON.parse(inputs['config.json'].toString('utf8'));
const settings = tokenizerSettings(tokenizer, config);
const vocab = vocabList(tokenizer, rows);
if (!(settings.unknownToken in tokenizer.model.vocab)) fail('unknown token is not in the vocabulary');
const { q, scales } = int8Rows({ rows, dim, matrix });
const table = encodeTable({ rows, dim, settings, vocab, scales, q });

const outDir = path.resolve(out);
fs.mkdirSync(outDir, { recursive: true });
const binName = `${NAME}.int8.bin`;
fs.writeFileSync(path.join(outDir, binName), table);

// The licence file lives in the repository's models/ whatever --out is, so the manifest is the same either way.
const licencePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models', SOURCE.licenceFile);
const manifest = {
  name: NAME,
  file: binName,
  formatVersion: FORMAT_VERSION,
  dimension: dim,
  rows,
  quantisation: 'int8, one Float32 scale per row (max |value| / 127)',
  bytes: table.length,
  sha256: sha256(table),
  source: {
    model: SOURCE.model,
    url: SOURCE.url,
    revision: SOURCE.revision,
    licence: SOURCE.licence,
    licenceFile: SOURCE.licenceFile,
    licenceFileSha256: fs.existsSync(licencePath) ? sha256(fs.readFileSync(licencePath)) : null,
    licenceSource: SOURCE.licenceSource
  },
  inputs: Object.fromEntries(Object.entries(inputs).map(([file, bytes]) => [file, { bytes: bytes.length, sha256: sha256(bytes) }])),
  tokenizer: settings,
  build: `node scripts/build-embedding-table.mjs <${SOURCE.model} model dir> --out models/`
};
fs.writeFileSync(path.join(outDir, `${NAME}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${path.join(outDir, binName)}  ${table.length} bytes  sha256 ${manifest.sha256}`);
