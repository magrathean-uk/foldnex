// Static word-embedding table reader: WordPiece tokens, int8 rows with one scale
// per row, averaged. No dependency, no WebAssembly. The table is
// models/potion-base-4M.int8.bin (minishlab/potion-base-4M, MIT), written by
// scripts/build-embedding-table.mjs.
//
// File format, version 1 (all integers little-endian):
//   offset 0   4 bytes   magic "FXEM"
//          4   u32       format version (1)
//          8   u32       dimension (128)
//         12   u32       row count = vocabulary size
//         16   u32       settings length S, bytes
//         20   u32       vocabulary length V, bytes
//         24   S bytes   settings: UTF-8 JSON copied from tokenizer.json and config.json
//                        {lowercase, stripAccents, cleanText, handleChineseChars,
//                         unknownToken, continuingSubwordPrefix, maxInputCharsPerWord,
//                         dropUnknown, normalize}
//       24+S   V bytes   vocabulary: UTF-8 tokens joined by "\n", token i is id i
//     then     0-3 zero bytes so the next block starts on a multiple of 4
//     then     rows x f32  scale per row (max |value| / 127, 0 for an all-zero row)
//     then     rows x dim x i8  matrix, row-major; value = int8 * scale
// The file length must equal the end of the matrix exactly.
//
// Everything here is pure except loadTable(). No Node modules are imported, so the
// extension loads this file as it is.

export const TABLE_PATH = 'models/potion-base-4M.int8.bin';
export const FORMAT_VERSION = 1;

const MAGIC = 'FXEM';
const HEADER_BYTES = 24;
const MAX_JSON_BYTES = 4096;
const MAX_ROWS = 1_000_000;
const MAX_VOCAB_BYTES = 32 * 1024 * 1024;

// Work bounds per text: a title is cut before tokenising, a word over
// MAX_WORD_CHARS is unknown without a WordPiece search, and at most
// MAX_TOKENS ids are kept.
const MAX_TEXT_CHARS = 200;
const MAX_WORD_CHARS = 40;
const MAX_TOKENS = 64;

// --- parsing ---------------------------------------------------------------

/** Views a table file as a table object, or throws a clear Error. No per-row allocation. */
export function parseTable(buffer) {
  if (buffer instanceof Uint8Array) buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  if (!(buffer instanceof ArrayBuffer)) throw new Error('Embedding table: expected an ArrayBuffer');
  if (buffer.byteLength < HEADER_BYTES) throw new Error('Embedding table: file too short for its header');
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== MAGIC) throw new Error('Embedding table: wrong magic, not a Foldnex table');
  const version = view.getUint32(4, true);
  if (version !== FORMAT_VERSION) throw new Error(`Embedding table: unsupported format version ${version}`);
  const dim = view.getUint32(8, true);
  const rows = view.getUint32(12, true);
  const settingsLength = view.getUint32(16, true);
  const vocabLength = view.getUint32(20, true);
  if (dim < 1 || dim > 4096 || rows < 1 || rows > MAX_ROWS || settingsLength < 2 || settingsLength > MAX_JSON_BYTES || vocabLength > MAX_VOCAB_BYTES) {
    throw new Error('Embedding table: implausible header values');
  }
  const vocabStart = HEADER_BYTES + settingsLength;
  const scalesStart = (vocabStart + vocabLength + 3) & ~3;
  const matrixStart = scalesStart + rows * 4;
  const end = matrixStart + rows * dim;
  if (buffer.byteLength !== end) throw new Error(`Embedding table: length ${buffer.byteLength} does not match the ${end} its header describes`);

  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let settings;
  let tokens;
  try {
    settings = JSON.parse(decoder.decode(new Uint8Array(buffer, HEADER_BYTES, settingsLength)));
    tokens = decoder.decode(new Uint8Array(buffer, vocabStart, vocabLength)).split('\n');
  } catch {
    throw new Error('Embedding table: settings or vocabulary are not valid');
  }
  if (tokens.length !== rows) throw new Error(`Embedding table: ${tokens.length} vocabulary entries for ${rows} rows`);
  if (!settings || typeof settings.unknownToken !== 'string' || typeof settings.continuingSubwordPrefix !== 'string') {
    throw new Error('Embedding table: tokenizer settings are missing');
  }
  const { maxInputCharsPerWord: maxChars, continuingSubwordPrefix: prefix } = settings;
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 1000) throw new Error('Embedding table: maxInputCharsPerWord out of range');
  if (prefix.length > 16) throw new Error('Embedding table: continuingSubwordPrefix out of range');
  const vocab = new Map();
  for (let id = 0; id < rows; id++) vocab.set(tokens[id], id);
  if (vocab.size !== rows) throw new Error('Embedding table: duplicate vocabulary entries');

  const scales = new Float32Array(buffer, scalesStart, rows);
  for (let id = 0; id < rows; id++) {
    if (!Number.isFinite(scales[id]) || scales[id] < 0) throw new Error(`Embedding table: scale of row ${id} is not a finite non-negative number`);
  }

  return {
    version,
    dim,
    rows,
    settings,
    vocab,
    unkId: vocab.get(settings.unknownToken),
    scales,
    q: new Int8Array(buffer, matrixStart, rows * dim)
  };
}

// --- tokeniser: BERT normaliser, BERT pre-tokeniser, WordPiece ---------------

// Split on ASCII and Unicode punctuation, and (when handleChineseChars is set)
// around each CJK ideograph, the BMP and supplementary ranges of BERT's _is_chinese_char.
const PUNCT = '[!-\\/:-@\\[-`{-~\\p{P}]';
const CJK = '[㐀-䶿一-鿿豈-﫿\\u{20000}-\\u{2A6DF}\\u{2A700}-\\u{2B73F}\\u{2B740}-\\u{2B81F}\\u{2B820}-\\u{2CEAF}\\u{2F800}-\\u{2FA1F}]';
const SPLIT_CJK = new RegExp(`(${PUNCT}|${CJK})`, 'u');
const SPLIT_PLAIN = new RegExp(`(${PUNCT})`, 'u');

// clean_text deletes NUL, U+FFFD and every "other" character (Cc, Cf, Cn, Co,
// Cs) except tab, CR and LF. Deleting, not spacing, matters: a zero-width
// space or soft hyphen inside a word joins its halves.
const DROPPED = /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}�]/gu;

function words(table, text) {
  const { cleanText, stripAccents, lowercase, handleChineseChars } = table.settings;
  let clean = String(text || '');
  if (cleanText) clean = clean.replace(DROPPED, '');
  // Same order as the Rust normaliser: strip accents (NFD, drop Mn, no
  // recomposition), then lowercase one character at a time, so a word-final
  // capital sigma becomes σ, not the contextual ς that toLowerCase() gives.
  if (stripAccents) clean = clean.normalize('NFD').replace(/\p{Mn}+/gu, '');
  if (lowercase) clean = Array.from(clean, char => char.toLowerCase()).join('');
  const split = handleChineseChars ? SPLIT_CJK : SPLIT_PLAIN;
  const out = [];
  for (const chunk of clean.split(/\s+/u)) {
    for (const piece of chunk.split(split)) if (piece) out.push(piece);
  }
  return out;
}

/**
 * WordPiece ids of a text, bounded (see MAX_TEXT_CHARS, MAX_WORD_CHARS,
 * MAX_TOKENS). A word with no match is the unknown token, which is left out.
 * `memo` (a Map the caller keeps for one window) holds each word's pieces, so a
 * repeated word is searched once.
 */
export function tokenIds(table, text, memo = null) {
  const { dropUnknown } = table.settings;
  const ids = [];
  for (const word of words(table, String(text || '').slice(0, MAX_TEXT_CHARS))) {
    // A cached null (an unknown word) is a hit too.
    let pieces = memo?.get(word);
    if (pieces === undefined) {
      pieces = wordPieces(table, word);
      memo?.set(word, pieces);
    }
    if (pieces) ids.push(...pieces);
    else if (!dropUnknown) ids.push(table.unkId);
    if (ids.length >= MAX_TOKENS) return ids.slice(0, MAX_TOKENS);
  }
  return ids;
}

/** Piece ids of one word, or null when it is unknown (too long or no match). */
function wordPieces(table, word) {
  const { continuingSubwordPrefix: prefix, maxInputCharsPerWord: maxChars } = table.settings;
  {
    // WordPiece counts and slices characters (code points), not UTF-16 units.
    const chars = Array.from(word);
    if (chars.length > Math.min(maxChars, MAX_WORD_CHARS)) return null;
    const pieces = [];
    let start = 0;
    let matched = true;
    while (start < chars.length) {
      let end = chars.length;
      let id;
      while (start < end) {
        id = table.vocab.get((start > 0 ? prefix : '') + chars.slice(start, end).join(''));
        if (id !== undefined) break;
        end--;
      }
      if (id === undefined) {
        matched = false;
        break;
      }
      pieces.push(id);
      start = end;
    }
    return matched ? pieces : null;
  }
}

// --- url words and the window embedding --------------------------------------

const URL_NOISE = new Set(['www', 'com', 'co', 'uk', 'org', 'net', 'io', 'html', 'php', 'htm', 'en', 'gb', 'index', 'docs', 'app']);

/** Host and path words of a URL as one lowercase string, without noise words; '' for a bad URL. */
export function urlWords(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname} ${parsed.pathname}`.toLowerCase().split(/[^a-z0-9]+/)
      .filter(word => word.length > 1 && word.length < 25 && !URL_NOISE.has(word) && !/\d{3,}/.test(word))
      .slice(0, 8)
      .join(' ');
  } catch {
    return '';
  }
}

/**
 * One unit Float32Array per [title, urlWordsText] pair of one window. Token
 * vectors are summed (title weight 1, url words urlWeight), each token scaled
 * by its idf across the window when idf is on, then normalised. A pair with no
 * known token gives a zero vector.
 */
export function embedWindow(table, pairs, { idf = true, urlWeight = 0.5 } = {}) {
  const { dim, q, scales } = table;
  const memo = new Map();
  const lists = pairs.map(([title, url]) => ({ title: tokenIds(table, title, memo), url: tokenIds(table, url, memo) }));
  const df = new Map();
  if (idf) {
    for (const list of lists) {
      for (const id of new Set([...list.title, ...list.url])) df.set(id, (df.get(id) || 0) + 1);
    }
  }
  const weight = id => (idf ? Math.log((pairs.length + 1) / (df.get(id) + 0.5)) : 1);
  const sum = new Float64Array(dim);
  return lists.map(list => {
    sum.fill(0);
    const add = (ids, scale) => {
      for (const id of ids) {
        const factor = scale * weight(id) * scales[id];
        const offset = id * dim;
        for (let d = 0; d < dim; d++) sum[d] += factor * q[offset + d];
      }
    };
    add(list.title, 1);
    add(list.url, urlWeight);
    let norm = 0;
    for (let d = 0; d < dim; d++) norm += sum[d] * sum[d];
    norm = Math.sqrt(norm) || 1;
    const vector = new Float32Array(dim);
    for (let d = 0; d < dim; d++) vector[d] = sum[d] / norm;
    return vector;
  });
}

// --- loading -----------------------------------------------------------------

let loading = null;

async function readPackagedTable() {
  const response = await fetch(chrome.runtime.getURL(TABLE_PATH));
  if (!response.ok) throw new Error(`Embedding table: HTTP ${response.status}`);
  return response.arrayBuffer();
}

/**
 * Fetches, parses and caches the packaged table for the life of the worker.
 * Never throws: resolves to null when the file is missing, unreadable or fails
 * its checks, and the caller works on title words alone. Concurrent calls share
 * one load. A failed load is not cached, so a later call tries again.
 * `read` (tests only) replaces the fetch: an async function returning an ArrayBuffer.
 */
export function loadTable({ read = readPackagedTable } = {}) {
  if (!loading) {
    const attempt = (async () => {
      try {
        return parseTable(await read());
      } catch {
        return null;
      }
    })();
    loading = attempt;
    attempt.then(table => {
      if (!table && loading === attempt) loading = null;
    });
  }
  return loading;
}

/** Forgets the cached table (tests). */
export function resetTableCache() {
  loading = null;
}
