// Validates the evaluation data: fixture windows and, when present, the
// labelled title set. Exit 1 on any error.   node eval/check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { CATEGORY_KEYS } from './frozen.mjs';
import { isSocialSite } from '../src/site-clusterer.js';
import { PLAN_EXAMPLE_NAME } from '../src/ai-engine.js';
import { FIXTURES_DIR, loadWindowRows } from './lib.mjs';

const keys = new Set(CATEGORY_KEYS);
const errors = [];
const fail = message => errors.push(message);

const windows = await loadWindowRows();
// The plan prompt's example folder name must not give an answer away: no word of it in a gold task
// name of any window, and the whole name in no tab title.
const exampleWords = PLAN_EXAMPLE_NAME.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const wordsOf = text => String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
for (const [name, rows] of Object.entries(windows)) {
  if (!Array.isArray(rows) || rows.length < 30 || rows.length > 250) fail(`${name}: needs 30 to 250 tabs, has ${rows?.length}`);
  const urls = new Set();
  const tasks = new Map();
  let loose = 0;
  (rows || []).forEach((row, index) => {
    const where = `${name}[${index}]`;
    if (!Array.isArray(row) || row.length !== 4) return fail(`${where}: a row is [title, url, category, task]`);
    const [title, url, cat, task] = row;
    if (typeof title !== 'string' || !title.trim()) fail(`${where}: empty title`);
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      fail(`${where}: bad url ${url}`);
    }
    if (parsed && !/^https?:$/.test(parsed.protocol)) fail(`${where}: url must be http or https`);
    if (parsed && isSocialSite(url)) fail(`${where}: social site (${parsed.hostname}); Socials is a locked group, leave these out`);
    if (urls.has(url)) fail(`${where}: duplicate url in this window`);
    urls.add(url);
    if (!keys.has(cat)) fail(`${where}: unknown category "${cat}"`);
    if (typeof title === 'string' && title.toLowerCase().includes(PLAN_EXAMPLE_NAME.toLowerCase())) fail(`${where}: title contains the plan prompt's example name "${PLAN_EXAMPLE_NAME}"`);
    if (typeof task === 'string') {
      const clash = wordsOf(task).filter(word => exampleWords.includes(word));
      if (clash.length) fail(`${where}: task "${task}" shares "${clash.join(', ')}" with the plan prompt's example name "${PLAN_EXAMPLE_NAME}"`);
    }
    if (task === null) loose++;
    else if (typeof task !== 'string' || !task.trim()) fail(`${where}: task is a name or null`);
    else tasks.set(task, (tasks.get(task) || 0) + 1);
  });
  if (tasks.size > 10) fail(`${name}: ${tasks.size} tasks, the product allows at most 10 groups`);
  if (tasks.size < 3) fail(`${name}: needs at least 3 tasks`);
  for (const [task, count] of tasks) if (count < 2) fail(`${name}: task "${task}" has one tab; use null for a tab with no group`);
  if (loose > 0.2 * rows.length) fail(`${name}: ${loose} tabs have no task (limit 20%)`);
  console.log(`${name}: ${rows.length} tabs, ${tasks.size} tasks, ${loose} without a task`);
}

const titlesFile = path.join(FIXTURES_DIR, '..', 'data', 'titles.jsonl');
if (fs.existsSync(titlesFile)) {
  const counts = new Map(CATEGORY_KEYS.map(key => [key, 0]));
  const seen = new Set();
  fs.readFileSync(titlesFile, 'utf8').split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return fail(`titles.jsonl:${index + 1}: not JSON`);
    }
    if (typeof row.title !== 'string' || !row.title.trim()) fail(`titles.jsonl:${index + 1}: empty title`);
    try {
      new URL(row.url);
    } catch {
      fail(`titles.jsonl:${index + 1}: bad url`);
    }
    if (!keys.has(row.cat)) return fail(`titles.jsonl:${index + 1}: unknown category "${row.cat}"`);
    const identity = `${row.title}\n${row.url}`;
    if (seen.has(identity)) fail(`titles.jsonl:${index + 1}: duplicate row`);
    seen.add(identity);
    counts.set(row.cat, counts.get(row.cat) + 1);
  });
  for (const [key, count] of counts) if (count < 100) fail(`titles.jsonl: category ${key} has ${count} rows, needs at least 100`);
  console.log(`titles.jsonl: ${seen.size} rows; smallest category ${Math.min(...counts.values())}`);
}

if (errors.length) {
  console.error(`\n${errors.length} error(s):\n${errors.slice(0, 40).join('\n')}`);
  process.exit(1);
}
console.log('ok');
