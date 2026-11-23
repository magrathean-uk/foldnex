// The bundled embedding table in a click's local result: used when it is
// loaded in time, skipped silently when it cannot be read or is late.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { resetTableCache, TABLE_PATH } from '../src/embedder.js';
import { executeTabGrouping } from '../src/grouper.js';

import { installBrowser, installProvider, makeTabs, OPENAI } from './plan-harness.js';

const TABLE_BYTES = fs.readFileSync(new URL(`../${TABLE_PATH}`, import.meta.url));
const OFFLINE = { provider: 'offline', groupingStrategy: 'task' };

/** The packaged table behind chrome.runtime.getURL; `gate` holds the read. Returns a restore function. */
function serveTable({ gate = null } = {}) {
  chrome.runtime = { getURL: path => `chrome-extension://foldnex/${path}` };
  const inner = globalThis.fetch;
  const reads = [];
  globalThis.fetch = async (url, options) => {
    if (String(url) === `chrome-extension://foldnex/${TABLE_PATH}`) {
      reads.push(url);
      if (gate) await gate;
      const copy = TABLE_BYTES.buffer.slice(TABLE_BYTES.byteOffset, TABLE_BYTES.byteOffset + TABLE_BYTES.byteLength);
      return { ok: true, status: 200, async arrayBuffer() { return copy; } };
    }
    return inner(url, options);
  };
  return { reads, restore() { globalThis.fetch = inner; } };
}

test('Offline smart mode uses the table when it loads and title words when it cannot be read', async () => {
  resetTableCache();
  installBrowser(makeTabs(401, 40100));
  const table = serveTable();
  try {
    const result = await executeTabGrouping(401, OFFLINE);
    assert.equal(result.source, 'offline');
    assert.equal(result.localEmbedding, 'table');
    assert.equal(table.reads.length, 1);
  } finally {
    table.restore();
  }

  resetTableCache();
  installBrowser(makeTabs(402, 40200));
  const result = await executeTabGrouping(402, OFFLINE);
  assert.equal(result.localEmbedding, 'words');
  assert.ok(result.groupsCreated > 0);
});

test('a provider failure and a late plan use the table once it is loaded', async () => {
  resetTableCache();
  installBrowser(makeTabs(403, 40300));
  const provider = installProvider({ status: 500 });
  const table = serveTable();
  try {
    const failed = await executeTabGrouping(403, OPENAI);
    assert.equal(failed.source, 'offline-fallback');
    assert.equal(failed.localEmbedding, 'table');
  } finally {
    table.restore();
    provider.restore();
  }

  installBrowser(makeTabs(404, 40400));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const late = installProvider({ gate });
  const loaded = serveTable();
  try {
    const result = await executeTabGrouping(404, OPENAI, { budgetMs: 300 });
    assert.equal(result.source, 'plan-pending');
    assert.equal(result.localEmbedding, 'table', 'the table cached by the last click is ready at once');
  } finally {
    release();
    loaded.restore();
    late.restore();
  }
});

test('a late plan never waits for a table that is still loading', async () => {
  resetTableCache();
  installBrowser(makeTabs(405, 40500));
  let releasePlan;
  const planGate = new Promise(resolve => { releasePlan = resolve; });
  const provider = installProvider({ gate: planGate });
  let releaseTable;
  const table = serveTable({ gate: new Promise(resolve => { releaseTable = resolve; }) });
  try {
    const startedAt = performance.now();
    const result = await executeTabGrouping(405, OPENAI, { budgetMs: 300 });
    assert.equal(result.source, 'plan-pending');
    assert.equal(result.localEmbedding, 'words');
    assert.ok(result.groupsCreated > 0);
    assert.ok(performance.now() - startedAt < 3000, 'the click returned without the table');
    assert.equal(table.reads.length, 1, 'the load started with the click');
  } finally {
    releaseTable();
    releasePlan();
    table.restore();
    provider.restore();
    resetTableCache();
  }
});
