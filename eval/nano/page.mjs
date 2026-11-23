// DOM glue for eval/nano/index.html. Logic lives in nano-eval.mjs.
import { loadWindows } from './common.mjs';

const $ = id => document.getElementById(id);
const status = text => { $('status').textContent = text; };
const fixturesUrl = new URL('../fixtures/', import.meta.url);

// python3 -m http.server lists a directory as links; that is how new fixture files are found.
async function listFiles() {
  const html = await (await fetch(fixturesUrl)).text();
  return [...html.matchAll(/href="([^"?#/]+\.mjs)"/g)].map(match => decodeURIComponent(match[1]));
}
const importFile = file => import(new URL(file, fixturesUrl).href);

const num = (value, digits = 2) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '-');
const secs = value => (typeof value === 'number' ? `${(value / 1000).toFixed(1)} s` : '-');

function render(outcome) {
  $('results').textContent = JSON.stringify(outcome, null, 1);
  const rows = outcome.results.length ? summaryRows(outcome) : [];
  $('table').innerHTML = rows.length
    ? `<thead><tr><th>Window</th><th>Tabs</th><th>Today: label acc.</th><th>Today F1</th><th>Today time</th><th>A F1</th><th>A pass 1</th><th>A pass 2</th><th>A total</th><th>A folders</th><th>A trimmed</th><th>Errors</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r.window}</td><td>${r.tabs}</td><td>${num(r.today_label_accuracy)}</td><td>${num(r.today_f1)}</td><td>${secs(r.today_ms)}</td><td>${num(r.a_f1)}</td><td>${secs(r.a_pass1_ms)}</td><td>${secs(r.a_pass2_ms)}</td><td>${secs(r.a_total_ms)}</td><td>${r.a_folders}</td><td>${r.a_trimmed}</td><td>${r.errors}</td></tr>`).join('')}</tbody>`
    : '';
}

async function main() {
  let defaultWindowNames, runEval, summaryRows, titleFor;
  try {
    ({ defaultWindowNames, runEval, summaryRows, titleFor } = await import('./nano-eval.mjs'));
  } catch (error) {
    // legacy-labels.mjs throws its message when the label pipeline is gone from src/.
    document.title = 'nano-eval: error label pipeline removed';
    status(String(error?.message || error));
    return;
  }
  let windows;
  try {
    windows = await loadWindows({ listFiles, importFile });
  } catch (error) {
    document.title = `nano-eval: error fixtures ${String(error?.message || error).slice(0, 40)}`;
    status(`Could not load fixtures: ${error?.message || error}`);
    return;
  }
  const defaults = new Set(defaultWindowNames(windows));
  $('picker').innerHTML = Object.entries(windows).map(([name, tabs]) =>
    `<label><input type="checkbox" value="${name}" ${defaults.has(name) ? 'checked' : ''}> ${name} (${tabs.length})</label>`).join('');
  const hasApi = typeof globalThis.LanguageModel?.availability === 'function';
  status(hasApi ? 'Ready. Press Run (a click is needed if the model must download).' : 'Prompt API missing: this Chrome has no LanguageModel.');
  if (!hasApi) document.title = titleFor({ status: 'error', reason: 'Prompt API missing' });
  else document.title = 'nano-eval: ready';

  const run = async () => {
    const names = [...document.querySelectorAll('#picker input:checked')].map(input => input.value);
    $('run').disabled = true;
    document.title = 'nano-eval: running';
    let outcome;
    try {
      outcome = await runEval({ windows, names, onProgress: status });
    } catch (error) {
      outcome = { status: 'error', reason: String(error?.message || error), results: [] };
    }
    render(outcome);
    document.title = titleFor(outcome);
    status(outcome.status === 'done' ? `Done${outcome.failed?.length ? ` (failures in: ${outcome.failed.join(', ')})` : ''}.` : `Error: ${outcome.reason}`);
    $('run').disabled = false;
  };
  $('run').addEventListener('click', run);
  // ?auto=1 starts without a click (the model must already be downloaded); ?windows=dev,life picks windows.
  const query = new URLSearchParams(location.search);
  if (query.get('windows')) {
    const wanted = new Set(query.get('windows').split(','));
    document.querySelectorAll('#picker input').forEach(input => { input.checked = wanted.has(input.value); });
  }
  if (query.get('auto') === '1') run();
}

main();
