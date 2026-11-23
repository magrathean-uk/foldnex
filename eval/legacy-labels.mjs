// The only door from the evaluation to the per-tab label pipeline, which Phase 4 removed from src/.
// Scripts that reproduce a label, rules or Nano baseline import what they need from here. The names are
// loaded dynamically: when any is missing the script prints one message and stops with exit code 1
// (in a browser page it throws an Error with the same text). Live scripts never import this module.
// The pipeline is not copied into eval/: those baselines run at commit c669dcb.
export const REMOVED_MESSAGE = 'this script reproduces a baseline of the label pipeline, removed in Phase 4; check out c669dcb to run it';

const WANTED = {
  '../src/planner.js': ['planGroups', 'inferLocalLabel', 'buildLocalContext'],
  '../src/ai-engine.js': [
    'LABEL_SYSTEM', 'LABEL_SYSTEM_ROWS', 'buildLabelPrompt', 'formatLabelLines', 'formatLabelRows',
    'labelSchema', 'labelOutputBudget', 'parseLabelResponse', 'cloudLabelBatchSize'
  ],
  '../src/label-vocabulary.js': ['LABEL_CATEGORIES']
};

const found = {};
const missing = [];
for (const [file, names] of Object.entries(WANTED)) {
  let module = {};
  try {
    module = await import(file);
  } catch {
    // A module that no longer loads counts as missing names below.
  }
  for (const name of names) {
    if (module[name] === undefined) missing.push(name);
    else found[name] = module[name];
  }
}

if (missing.length) {
  if (typeof process !== 'undefined' && typeof process.exit === 'function') {
    console.error(REMOVED_MESSAGE);
    process.exit(1);
  }
  throw new Error(REMOVED_MESSAGE);
}

export const {
  planGroups, inferLocalLabel, buildLocalContext,
  LABEL_SYSTEM, LABEL_SYSTEM_ROWS, buildLabelPrompt, formatLabelLines, formatLabelRows,
  labelSchema, labelOutputBudget, parseLabelResponse, cloudLabelBatchSize,
  LABEL_CATEGORIES
} = found;
