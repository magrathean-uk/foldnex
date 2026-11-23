// A hostile window (200 tabs, 4000-character titles of 100-letter words) must not
// stall an on-time model plan once the table is loaded.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { resetTableCache, TABLE_PATH } from '../src/embedder.js';
import { executeTabGrouping } from '../src/grouper.js';

import { installBrowser, installProvider, OPENAI } from './plan-harness.js';

const TABLE_BYTES = fs.readFileSync(new URL(`../${TABLE_PATH}`, import.meta.url));
const JUNK = ('a'.repeat(100) + ' ').repeat(40);

function hostileTabs(windowId, startId) {
  return Array.from({ length: 200 }, (_, index) => ({
    id: startId + index, windowId, index, active: index === 0, pinned: false, incognito: false, status: 'complete', groupId: -1,
    title: `${index % 2 ? 'Telescope' : 'Sourdough'} ${JUNK}`,
    url: `https://www.site-${startId + index}.com/page/${index}`
  }));
}

async function timedClick(windowId, withTable) {
  resetTableCache();
  installBrowser(hostileTabs(windowId, windowId * 100));
  chrome.runtime = { getURL: path => `chrome-extension://foldnex/${path}` };
  const provider = installProvider();
  const inner = globalThis.fetch;
  if (withTable) {
    globalThis.fetch = async (url, options) => {
      if (String(url) === `chrome-extension://foldnex/${TABLE_PATH}`) {
        const copy = TABLE_BYTES.buffer.slice(TABLE_BYTES.byteOffset, TABLE_BYTES.byteOffset + TABLE_BYTES.byteLength);
        return { ok: true, status: 200, async arrayBuffer() { return copy; } };
      }
      return inner(url, options);
    };
  }
  try {
    const startedAt = performance.now();
    const result = await executeTabGrouping(windowId, OPENAI);
    return { ms: performance.now() - startedAt, result };
  } finally {
    globalThis.fetch = inner;
    provider.restore();
    resetTableCache();
  }
}

test('an on-time model plan on a hostile window is not stalled by the table', async () => {
  await timedClick(601, true);
  const without = await timedClick(602, false);
  const withTable = await timedClick(603, true);
  assert.equal(withTable.result.source, 'cloud-plan');
  console.log(`on-time plan, hostile window: ${withTable.ms.toFixed(0)} ms with the table, ${without.ms.toFixed(0)} ms without`);
  // Typically under 60 ms; the unbounded form took seconds. The margin is wide so a loaded machine does not fail it.
  assert.ok(withTable.ms - without.ms < 1500, `the table added ${(withTable.ms - without.ms).toFixed(0)} ms`);
});
