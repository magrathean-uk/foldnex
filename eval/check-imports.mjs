// Guards the evaluation against the removal of the per-tab label pipeline from src/ (Phase 4).
//   node eval/check-imports.mjs
// Fails (exit 1) when
//   1. a file under eval/ other than legacy-labels.mjs imports a name that is gone from src/, or
//   2. a live script reaches legacy-labels.mjs or lib-legacy.mjs through static imports.
// Dynamic import() is not followed: a live script may load legacy-labels.mjs lazily for a baseline mode
// (run-provider.mjs --mode labels, report-phase1.mjs on a label recording). Reads files only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EVAL = path.dirname(fileURLToPath(import.meta.url));

// Names the Phase 4 removal takes out of src/ (LABEL_CATEGORIES, CATEGORY_KEYS and buildLabelSystem possibly).
const GONE = new Set([
  'planGroups', 'inferLocalLabel', 'buildLocalContext', 'labelPriority', 'enforceFolders', 'taskMin',
  'LABEL_SYSTEM', 'LABEL_SYSTEM_ROWS', 'buildLabelPrompt', 'formatLabelLines', 'formatLabelRows', 'labelSchema',
  'labelOutputBudget', 'parseLabelResponse', 'cloudLabelBatchSize', 'labelTabsWithCloud', 'labelTabsWithAI',
  'LABEL_CATEGORIES', 'CATEGORY_KEYS', 'buildLabelSystem'
]);

// Scripts that must keep running without the label pipeline (paths relative to eval/).
const LIVE = [
  'check.mjs', 'check-imports.mjs', 'product-local.mjs', 'upkeep-unseen.mjs', 'run-upkeep-plans.mjs', 'run-engine.mjs',
  'phase1-lib.mjs', 'run-provider.mjs', 'report-phase1.mjs', 'local-ablation.mjs', 'local-embedders.mjs', 'local-refcheck.mjs',
  'local-upkeep.mjs', 'local-cluster.mjs', 'scoring.mjs', 'lib.mjs', 'frozen.mjs', 'provider-claude.mjs', 'provider-summary.mjs'
];
const LEGACY = new Set(['legacy-labels.mjs', 'lib-legacy.mjs']);

function listMjs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'results' ? [] : listMjs(full);
    return entry.name.endsWith('.mjs') ? [full] : [];
  });
}

// Static imports and re-exports: { specifier, names (named imports, [] otherwise) }.
function staticImports(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out = [];
  const pattern = /^\s*(?:import|export)\s+([^;'"]*?)\s*from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
  for (const match of code.matchAll(pattern)) {
    const clause = match[1] || '';
    const braces = clause.match(/\{([^}]*)\}/);
    const names = braces ? braces[1].split(',').map(part => part.trim().split(/\s+as\s+/)[0]).filter(Boolean) : [];
    out.push({ specifier: match[2] || match[3], names });
  }
  return out;
}

const files = listMjs(EVAL);
const errors = [];
const graph = new Map();
for (const file of files) {
  const imports = staticImports(fs.readFileSync(file, 'utf8'));
  const edges = [];
  for (const { specifier, names } of imports) {
    if (!specifier.startsWith('.')) continue;
    const target = path.resolve(path.dirname(file), specifier);
    const relative = path.relative(EVAL, target);
    if (relative.startsWith('..')) {
      for (const name of names) {
        if (GONE.has(name)) errors.push(`${path.relative(EVAL, file)}: imports ${name} from ${specifier}; it is gone after Phase 4 (use legacy-labels.mjs or a local copy)`);
      }
    } else {
      edges.push(relative);
    }
  }
  graph.set(path.relative(EVAL, file), edges);
}

for (const name of LIVE) {
  if (!graph.has(name)) {
    errors.push(`${name}: listed as live but missing`);
    continue;
  }
  // Walk the static imports from this script.
  const seen = new Set([name]);
  const queue = [[name, [name]]];
  while (queue.length) {
    const [current, trail] = queue.shift();
    for (const next of graph.get(current) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      if (LEGACY.has(path.basename(next))) errors.push(`${name}: reaches ${next} through ${[...trail, next].join(' -> ')}`);
      else queue.push([next, [...trail, next]]);
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`check-imports: ok (${files.length} files, ${LIVE.length} live scripts reach none of the removed names)`);
