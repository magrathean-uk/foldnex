# Gemini Nano evaluation (Phase 0b)

Run on 22 November 2026 in Chrome 158 on an Apple M3 Pro, from `eval/nano/` served at `http://localhost:8766/eval/nano/`, with the model already loaded. Web pages cannot set greedy sampling, so answers use Chrome's default sampling; the extension uses greedy decoding where Chrome allows it.

Cold start, measured separately on the same machine while five worker sessions were running: `LanguageModel.create()` took 285 seconds; the first prompt then took 0.2 seconds. Context window reported: 9,216 tokens.

"Today" is the product's design: labels in batches of 16 with the product's prompt and schema, then the planner. "Candidate A" is two passes: Nano names up to ten folders from all titles, then assigns tabs to them in batches of 16.

| Window | Tabs | Today: label accuracy | Today: F1 | Today: time | Candidate A: F1 | Candidate A: time | Note |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| dev | 63 | 0.71 | 0.37 | 17.8 s | 0.31 | 15.8 s | 17 tabs left unassigned by A |
| life | 62 | 0.58 | 0.55 | 13.4 s | 0.25 | 19.2 s | |
| b-move | 54 | 0.57 | 0.44 | 15.9 s | 0.23 | 16.7 s | |
| b-academic | 69 | 0.55 | 0.27 | 18.3 s | 0.16 | 18.0 s | |
| b-expat | 54 | 0.67 | 0.37 | 15.1 s | 0.00 | 60.2 s | A pass 1 timed out after 60 s |
| b-messy | 74 | 0.64 | 0.47 | 18.1 s | 0.23 | 19.5 s | |
| b-shop | 55 | 0.55 | 0.25 | 11.2 s | 0.13 | 15.5 s | |
| a-student | 64 | 0.63 | 0.48 | 16.4 s | 0.28 | 18.0 s | |
| a-oncall | 82 | 0.54 | 0.35 | 19.0 s | 0.20 | 20.9 s | |
| a-household | 63 | 0.79 | 0.55 | 12.4 s | 0.22 | 15.7 s | German and Hungarian |
| a-designer | 66 | 0.58 | 0.42 | 15.0 s | 0.00 | 60.4 s | A pass 1 timed out after 60 s |
| Mean of eleven | | 0.62 | 0.41 | 15.7 s | 0.18 | | |

| Mean of nine (excluding dev and life) | | 0.61 | 0.40 | 15.7 s | 0.16 | | |

The 200-tab window was not run. `dev` and `life` were used to draft the prompts (Candidate A's example folder name is one of `dev`'s gold groups), so the nine-window means are the cleaner figures; they are computed from the two-decimal values in the table.

Scope: F1 covers tabs with a gold task only. The raw per-tab assignments and the timeout records were not kept, so these figures cannot be rescored under the applied-result policy of `eval/results/rescore.md`.

Reading: Nano labels about six tabs in ten correctly and needs about a quarter of a second per tab when warm. Through today's planner that gives F1 0.41 over eleven windows (0.40 over the nine), close to the model-free local engine on the same windows (4M held-out 0.43 over the eleven, 0.40 over the nine), which runs in milliseconds. Nano is better than the local engine on the German and Hungarian window (0.55 against 0.27) and worse on most English ones. Candidate A as tested (two passes, fixed batches of 16, Chrome's default sampling) misses the bar in the plan (local floor plus 0.15): 0.18 over eleven windows, 0.16 over the nine, and 0.22 over the nine windows it completed. The product would size batches to the remaining time and can use greedy sampling, which this page did not test. Candidate B (Nano only names the local groups) was not measured.
