# Grouping evaluation

Evidence for `docs/development/grouping-fix-plan.md`. Not product code and not shipped.

## Models

Model2Vec static tables from Hugging Face, MIT licence: `minishlab/potion-base-8M`, `-4M` and `-2M`.
Put each in its own folder under one models directory, holding `model.safetensors`, `tokenizer.json`
and `config.json` (`huggingface-cli download minishlab/potion-base-4M --local-dir <dir>/potion-base-4M`).
Model files never go into this repo.

## Data

- `fixtures/*.mjs`: windows as `export const WINDOWS = {name: [[title, url, category, task|null], ...]}`. New files are picked up as they are.
- `data/titles.jsonl`: labelled titles `{title, url, cat}` for the local classifier. Optional; without it the classifier rows are skipped.
- `node eval/check.mjs` validates both.

**Provenance.** The windows and the title corpus are synthetic: a model wrote them to resemble ordinary browsing, and no row comes from a real browser, tab export or browsing history. Personal-looking values use reserved domains (`example.com`, `example.org`) and visibly dummy identifiers (mailbox addresses, street addresses, account, tax and bank numbers, user names in URLs); names of people and businesses in titles are invented. Recorded provider results under `results/` stay as recorded: they are records of runs on the earlier text, before those values were replaced on 23 November 2026.

## Scripts

| Command | What it does |
| --- | --- |
| `node eval/run-local.mjs <models dir>` | Every local variant on every window, tunables chosen leave-one-window-out, plan upkeep from gold groups and a Node proxy timing. Writes `results/local.json` and `results/local.md`. Options: `--titles <jsonl>`, `--out <dir>`, `--python <python with model2vec>` (re-runs the embedder check; otherwise its last result is kept). About 2.5 minutes for the twelve windows. |
| `node eval/rescore.mjs <models dir>` | Every Phase 0 path under the one scoring policy below: recorded and applied scores on twelve and ten windows, raw validity of the model answers, the paired Haiku comparison, upkeep from recorded plans and a cross-check against the independent review. Reads the fixtures, `results/local.json`, `results/ablation.json` and the recorded answers in `results/provider/full/`; calls no model. Writes `results/rescore.json` and `results/rescore.md` in seconds. Exits 1 if a replay differs from the recorded reports. |
| `node eval/local-ablation.mjs <models dir>` | The title-word channel alone, the embedding channel alone and the blend, for clusters and plan upkeep. Writes `results/ablation.*`. |
| `node eval/local-variants.mjs <models dir>` | Two refinements of the local engine, measured and not built: variant A (the old rule cascade on the tabs the engine leaves unassigned, its groups added within ten) and variant B (a cluster over half the window cut again at tau + 0.05, 0.1, 0.2), each also together; plus the baseline, A and the old cascade on 20 seeded subsets of 8, 15 and 25 tabs per window. Writes `results/local-variants.*`. |
| `node eval/local-embedders.mjs <vectors.json> <models dir>` | Transformer embedders against the static tables, same clustering and selection. The vectors come from `python eval/ref-embedders.py <vectors.json> <model cache dir>` (needs `fastembed` in a venv; downloads the models). Writes `results/embedders.*`. |
| `node eval/run-provider.mjs --model <id> --mode plan\|labels [--thinking adaptive --effort low] --repeats 2` | Claude models through the Claude API: one plan request per window, or today's label requests. Needs `ANTHROPIC_API_KEY` and spends money (`--max-cost`, default 1 USD a run). Writes one run file under `results/provider/`; `--summary-only` rebuilds `summary.md` from the run files. The Phase 0 matrix is in `results/provider/full/`. |
| `node eval/run-provider.mjs --matrix [--dry-run] [--repeats 2] [--max-cost 2] [--out <dir>]` | The Phase 1 Claude matrix: the five plan settings (Haiku 5.5 thinking off; Haiku adaptive, effort low; Sonnet 5.5 off; Sonnet adaptive, effort low; Opus 5.5 effort low) on all twelve windows, two repeats, with the product's plan prompt and schema from `src/ai-engine.js`. One file per setting in `results/provider/phase1/`. See "Phase 1 matrix" below. |
| `node eval/report-phase1.mjs <provider dir> [--out <dir>] [--compare results/rescore.json]` | Scores a directory of recordings (matrix, engine runs or the Phase 0 files) under the one policy and writes `report.md` and `report.json` there (or in `--out`): mean applied F1 on all and on tasked tabs over twelve and ten windows, raw validity, latency p50 and p90 overall and in three size bands, cost per window, agreement between repeats, failures and the Phase 1 bar. Calls no model. `--compare` checks the model rows against `rescore.json` (exit 1 on a difference above 5e-5). |
| `node eval/run-engine.mjs --engine <id> [--model <id>] [--priority on\|off\|both] [--price-in <usd> --price-out <usd>] [--stub]` | One product engine (`openai`, `gemini_api`, `xai`, `groq`, `openrouter`, `deepseek`, `cerebras`, `ollama`) measured through `requestProviderJson` of `src/ai-engine.js` with usage recording off, same units and directory as the matrix. `--help` lists the options and the key variable of each engine. Cost is in tokens unless both prices are given (USD per million tokens; none are assumed). `--stub` answers from a local function in each provider's response shape: no network, no key. |
| `node eval/run-upkeep-plans.mjs [--dry-run] [--stub] [--max-cost 1] [--windows a,b] [--out <dir>]` | Phase 2 upkeep, step 1: plans that never saw the new tabs. For each window and each share of 10, 20, 30 and 50% a seeded set of tabs is hidden (`hiddenSet`, the first seed of each share in `rescore.mjs`, so the hidden sets are Phase 0's) and one plan request is sent for the visible tabs only (Sonnet 5.5, thinking off, the product prompt and schema, no retries): 48 requests, one at a time, shares rotated within a window. One file in `results/provider/phase2-upkeep/` holds, per unit, the window, share, seed, hidden and visible tab ids (visible in the order sent), the raw answer, timings, tokens and cost. `--dry-run` prints the schedule and a cost estimate (Phase 1 Sonnet tokens, input scaled by the visible prompt length, output by the visible share); `--max-cost` (default 1 USD) stops cleanly; the key comes from `ANTHROPIC_API_KEY` only. `--stub` answers from the recorded Phase 1 Sonnet plan of the same window with the hidden tabs removed (no network; the file is marked `stub` and holds plans that did see the hidden tabs, so it checks the pipeline and is not the measurement). |
| `node eval/upkeep-unseen.mjs <recordings dir> [models dir]` | Phase 2 upkeep, step 2. Applies each recorded plan to its visible tabs, attaches the hidden tabs and scores the whole window against gold, for the product's `attachTabs` (`src/local-engine.js`, imported dynamically; skipped with a note if missing) and the prototype (`local-upkeep.mjs`, representation mean), each on title words and, with a models directory, on 4M vectors (idf on, centring off, title plus URL words at 0.5), over a grid of thresholds from none to 0.8. Reports per share: whole-window all-tab and tasked F1 with the hidden tabs attached, left out, and the fresh Phase 1 plan; F1 over pairs touching a new tab; where the hidden tabs went (right group, elsewhere, left out; loose tabs attached). The decision section gives the leave-one-window-out threshold per channel, its loose-tab wrong-attach rate and the smallest share at which attach trails a fresh plan by more than 0.03. Writes `report.md` and `report.json` into the recordings directory, or into `--out`. Deterministic, no model, a second. |
| `eval/nano/` | A page that drives Gemini Nano in Chrome on the same windows. Serve the repo root on localhost, open `/eval/nano/?auto=1&windows=dev,life` and wait for the title `nano-eval: done`. Results in `results/nano/summary.md`. |
| `node eval/local-refcheck.mjs <models dir> <python>` | Embedder against the Python `model2vec` package on 50 varied texts, all three tables; exit 1 below cosine 0.99. |
| `node eval/probe.mjs <models dir>` | The pilot on its two windows, kept for comparison. |
| `node eval/probe-llm.mjs prompts\|score <dir>` | Model prompts and scoring for the pilot answers. |

## Phase 1 matrix

The plan request is the product's (`buildPlanSystem`, `buildPlanUser`, `planJsonSchema` and `PLAN_EXAMPLE_NAME` in `src/ai-engine.js`). It is the pilot prompt of `probe-llm.mjs` with a new example folder name ("Wedding Plans"; the pilot's "Japan Trip" was a gold group of `life`). `check.mjs` fails if any word of the example name is in a gold task name or the whole name in a tab title. The Phase 0 recordings in `results/provider/full/` used the pilot wording, so the report marks them as not judged against the bar.

Schedule: 5 settings x 12 windows x 2 repeats = 120 requests, one at a time, no retries. A repeat walks the windows; on each window every setting runs once before the next window, and the setting that goes first rotates with (repeat x 12 + window index) mod 5. No setting is always first or runs in one block, and every setting meets the same windows (so size bands are matched). The file of each setting holds the raw answer, wall time, tokens, cost, the position in the schedule and the example name. `--max-cost` (default 2 USD) covers the whole matrix: before each request the Phase 0 cost of that setting and window is added to the spend and the run stops cleanly, writing what it has, if the cap would be passed (Ctrl-C does the same after the request in flight).

```sh
export ANTHROPIC_API_KEY=...                      # the key is read from here only
node eval/run-provider.mjs --matrix --dry-run     # schedule and estimate, sends nothing
node eval/run-provider.mjs --matrix               # spends money; writes results/provider/phase1/
node eval/report-phase1.mjs eval/results/provider/phase1
```

One other engine, with the key from its own variable (OpenAI shown; `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `CEREBRAS_API_KEY`, `OLLAMA_API_KEY`):

```sh
node eval/run-engine.mjs --engine openai --stub --windows b-move,b-expat    # check the path first, no network
export OPENAI_API_KEY=...
node eval/run-engine.mjs --engine openai --model <id> --priority both --price-in <usd> --price-out <usd>
node eval/report-phase1.mjs eval/results/provider/phase1
```

`--priority both` interleaves the OpenAI priority and default tiers window by window. Engine runs land in the same directory as the matrix, so one report compares them. The bar is judged only for complete runs (all twelve windows) made with the current wording; stub and partial recordings are shown but not judged. The budget the plan request asks for is the Phase 0 formula (`max(1024, 400 + 12 x tabs)` tokens); `requestProviderJson` scales it by the saved effort and caps it (1536 tokens at low effort), so the engine runs follow the product's cap, not the formula.

Reference Python, throwaway: `python3 -m venv $TMPDIR/m2v && $TMPDIR/m2v/bin/pip install model2vec`.

## Phase 2 upkeep

Upkeep from recorded plans (`rescore.mjs`) is optimistic: those plans had seen the tabs later hidden. This measures it from plans that did not.

```sh
node eval/run-upkeep-plans.mjs --dry-run                       # 48 requests and the estimate, sends nothing
export ANTHROPIC_API_KEY=...                                   # read from here only
node eval/run-upkeep-plans.mjs                                 # spends money (about 0.40 USD estimated); writes results/provider/phase2-upkeep/
node eval/upkeep-unseen.mjs eval/results/provider/phase2-upkeep <models dir, e.g. .../models/minishlab>
```

No-key check of the pipeline (`--stub` output goes outside the repo tree; keep it out of `results/`):

```sh
node eval/run-upkeep-plans.mjs --stub --out "$TMPDIR/upkeep-stub"
node eval/upkeep-unseen.mjs "$TMPDIR/upkeep-stub" <models dir>
```

Run the report on a directory of real recordings only: stub and real files in one directory are read together. A failed request is skipped by the report. Each window and share has one hidden set (seed `1000 x (share index + 1) + 1`, the first of the 20 that `rescore.mjs` averages), so expect a few hundredths of noise against the Phase 0 figures.

## Scoring

One policy, in `scoring.mjs`. The applied result of an answer: each tab is in at most one group (first
placement wins, unknown ids are ignored); tabs left out and tabs in a group named "Review Later" (any case)
are unassigned; at most ten groups, the Review Later pool counting as one of the ten when any tab is
unassigned, so the largest groups stay (ties by first appearance) and the rest become unassigned. Scores are
pairwise precision, recall and F1 with unassigned tabs as singletons, over two denominators: **tasked**, the
pairs among the 802 of 906 tabs that have a gold task (what every earlier report used), and **all tabs**,
where each of the 104 tabs without a gold task is a gold singleton. Raw validity of model answers (omitted,
duplicate and unknown ids, more than ten folders) is reported separately. The "recorded" columns score
answers as given, as the original reports did. `dev` and `life` were used to draft the plan prompt, so
model results are also given over the ten other windows.

## Reading the results

Pairwise precision, recall and F1 over tabs with a gold task, unless a report says all tabs. The headline for a variant is the
leave-one-window-out mean: for each window, the setting with the best mean F1 on the other windows is
scored on that window. The in-sample best (one setting over all windows) is reported beside it and is
optimistic by construction. Runs are seeded; two runs differ only in the `timing` block.

Modules: `scoring.mjs` (the scoring policy), `lib.mjs` (embedder, int8 tables, scoring glue, fixture loading), `local-cluster.mjs` (average-linkage
dendrogram), `local-classifier.mjs` (logistic regression), `local-upkeep.mjs` (plan upkeep from gold groups and the attach step),
`local-timing.mjs` (cold and warm timing of the label pipeline; historical), `ref-embed.py` (reference vectors), `provider-claude.mjs` (the Claude
request), `provider-summary.mjs` (the provider table), `phase1-lib.mjs` (the plan request and unit format shared by the Phase 1 scripts), `run-upkeep-plans.mjs` and `upkeep-unseen.mjs` (Phase 2 upkeep).

## Historical scripts

Phase 4 removed the per-tab label pipeline from `src/` (`planGroups`, `inferLocalLabel`, the label prompts, schemas and parsers, the rule cascade). The scripts whose numbers depend on it still hold their code but stop with exit 1 and the message "this script reproduces a baseline of the label pipeline, removed in Phase 4; check out c669dcb to run it" once the names are gone. At c669dcb they run as before. The pipeline is not copied here: `legacy-labels.mjs` is the only door to it (dynamic import, one message), and `lib-legacy.mjs` holds the helpers of `lib.mjs` that need it. The recorded results below are the evidence and are not regenerated.

| Script | Report it produced |
| --- | --- |
| `run-local.mjs` (with `local-timing.mjs`, `local-classifier.mjs`) | `results/local.json`, `results/local.md` |
| `rescore.mjs` | `results/rescore.json`, `results/rescore.md` |
| `local-variants.mjs` (variant A is the old rule cascade) | `results/local-variants.json`, `results/local-variants.md` |
| `probe.mjs`, `probe-llm.mjs` | the pilot on `dev` and `life`: console output and `results/dev-*.json`, `results/life-*.json` |
| `run-provider.mjs --mode labels` | the label rows of `results/provider/full/` and `results/provider/summary.md` |
| `report-phase1.mjs` on a directory with a label run | the replay of the label rows in `results/provider/full/` (`--compare results/rescore.json`); on plan recordings it needs no pipeline |
| `nano/` (`stub-check.mjs`, the page) | `results/nano/summary.md` |

Live without the pipeline: `check.mjs`, `product-local.mjs`, `run-upkeep-plans.mjs`, `upkeep-unseen.mjs`, `run-engine.mjs`, `run-provider.mjs --matrix` and `--mode plan`, `report-phase1.mjs` on plan recordings, `local-ablation.mjs`, `local-embedders.mjs`, `local-refcheck.mjs`, `local-upkeep.mjs`, `local-cluster.mjs`, `phase1-lib.mjs`, `scoring.mjs`, `lib.mjs`. `frozen.mjs` keeps copies of `CATEGORY_KEYS` and `taskMin` that these used from `src/`. `node eval/check-imports.mjs` fails if a live script reaches the removed names through static imports.
