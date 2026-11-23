// Runs the Nano page logic in Node against a stub LanguageModel with canned answers.
//   node eval/nano/stub-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as lib from '../lib.mjs';
import * as common from './common.mjs';
import { defaultWindowNames, runEval, summaryRows, titleFor, BATCH } from './nano-eval.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const listFiles = async () => fs.readdirSync(fixtures);
const importFile = file => import(pathToFileURL(path.join(fixtures, file)).href);

// The browser-safe copies must match lib.mjs exactly.
const windows = await common.loadWindows({ listFiles, importFile });
const reference = await lib.loadWindows();
assert.deepEqual(windows, reference, 'common.loadWindows differs from lib.loadWindows');
for (const tabs of Object.values(windows)) {
  const assignment = new Map(tabs.map(tab => [tab.id, tab.task || tab.id]));
  assert.deepEqual(common.score(assignment, tabs), lib.score(assignment, tabs), 'common.score differs from lib.score');
}

/** Stub Prompt API: enum fields cycle through their values, free strings become names. */
function stubLanguageModel({ availability = 'available', quota = 6144, failCreate = null } = {}) {
  const calls = { create: [], prompts: [] };
  const answer = schema => {
    const out = {};
    Object.entries(schema.properties).forEach(([key, spec], index) => {
      out[key] = spec.enum ? spec.enum[index % spec.enum.length] : (index < 4 ? `Folder ${index}` : '');
    });
    return JSON.stringify(out);
  };
  const makeSession = initial => ({
    inputQuota: quota,
    inputUsage: initial,
    measureInputUsage: async text => Math.ceil(text.length / 3),
    clone: async () => ({
      inputUsage: initial,
      prompt: async (text, options) => {
        assert.ok(options.responseConstraint?.type === 'object', 'schema must be a fixed-key object');
        assert.equal(options.omitResponseConstraintInput, true);
        for (const spec of Object.values(options.responseConstraint.properties)) assert.notEqual(spec.type, 'array', 'no array schemas');
        calls.prompts.push({ text, schema: options.responseConstraint });
        return answer(options.responseConstraint);
      },
      destroy() {}
    }),
    destroy() {}
  });
  return {
    calls,
    availability: async () => availability,
    create: async options => {
      calls.create.push(options);
      if (failCreate) throw Object.assign(new Error('boom'), { name: failCreate });
      return makeSession(10);
    }
  };
}

// 1. Default windows, normal quota: both designs produce results.
const chosen = defaultWindowNames(windows);
assert.ok(chosen.length >= 2 && chosen.every(name => windows[name].length <= 100));
const LanguageModel = stubLanguageModel();
const outcome = await runEval({ LanguageModel, windows, names: ['dev', 'life'] });
assert.equal(outcome.status, 'done');
assert.equal(titleFor(outcome), 'nano-eval: done');
assert.equal(outcome.results.length, 2);
for (const result of outcome.results) {
  const tabs = windows[result.window];
  assert.equal(result.today.batches.length, Math.ceil(tabs.length / BATCH));
  assert.equal(result.candidate_a.pass2.batches.length, Math.ceil(tabs.length / BATCH));
  for (const run of [result.today, result.candidate_a]) {
    assert.ok(run.ok, run.error);
    assert.ok(run.f1 >= 0 && run.f1 <= 1 && Number.isFinite(run.total_ms));
  }
  assert.ok(result.today.label_accuracy >= 0 && result.today.label_accuracy <= 1);
  assert.ok(result.candidate_a.pass1.folders.length >= 1);
  assert.equal(result.candidate_a.pass1.quota.trimmed, false);
}
assert.equal(summaryRows(outcome).length, 2);
JSON.stringify(outcome); // must serialise for <pre id="results">
// Greedy sampling is the first attempt, and every base carries a system prompt.
assert.deepEqual([LanguageModel.calls.create[0].topK, LanguageModel.calls.create[0].temperature], [1, 0]);
assert.ok(LanguageModel.calls.create.every(options => options.initialPrompts[0].role === 'system'));

// 2. A tiny quota makes pass 1 trim, and the result says so.
const small = await runEval({ LanguageModel: stubLanguageModel({ quota: 600 }), windows, names: ['dev'] });
assert.equal(small.status, 'done');
const quota = small.results[0].candidate_a.pass1.quota;
assert.equal(quota.trimmed, true);
assert.ok(quota.to < quota.from && quota.to >= 1, 'trimmed prompt must keep some tabs');
assert.equal(small.results[0].candidate_a.pass1.tabs_in_prompt, quota.to);
assert.equal(summaryRows(small)[0].a_trimmed, `${quota.from}->${quota.to}`);

// 3. Missing API and a model that is not ready are reported, not thrown.
const missing = await runEval({ LanguageModel: undefined, windows, names: ['dev'] });
assert.equal(missing.status, 'error');
assert.match(titleFor(missing), /^nano-eval: error Prompt API missing/);
const notReady = await runEval({ LanguageModel: stubLanguageModel({ availability: 'unavailable' }), windows, names: ['dev'] });
assert.equal(notReady.status, 'error');
assert.match(titleFor(notReady), /^nano-eval: error model not ready/);
const createFails = await runEval({ LanguageModel: stubLanguageModel({ failCreate: 'NotAllowedError' }), windows, names: ['dev'] });
assert.equal(createFails.status, 'error');
assert.match(titleFor(createFails), /^nano-eval: error model not ready/);

console.log(`stub-check ok (${Object.keys(windows).length} windows, default picks ${chosen.join(', ')})`);
