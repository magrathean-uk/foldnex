# Grouping fix plan: model plan, local floor

Status: Phases 1 to 5 done, 23 November 2026; Foldnex 2.1.0 is the release candidate. Phase 0 measured the pilot design on twelve windows and it failed its gate on two of three criteria; this version replaced the pilot plan. The results of each phase are under "Phase 1 result" to "Phase 5 result". Publishing to the Chrome Web Store is a manual release step.

## Outcome

Targets, from the Phase 0 numbers. F1 is agreement with hand-made task groups over every tab of a window; 1.00 is a perfect match.

- With a cloud engine or Ollama, one request per window returns the finished groups and names. Measured on Claude models, a mid or upper-tier model scores 0.80 to 0.87 where today's label requests score 0.40, in about 3 seconds for 1 to 2 US cents. The smallest tier scores 0.59 in 2 seconds for 0.06 cents.
- A model is called when the window has changed, not on every click. Its plan is remembered, and a few new tabs are attached on the device.
- With no model (Offline smart mode, incognito, a failed or late request) a click still gives a full grouping in milliseconds, at about 0.37 against 0.18 today (0.39 on all twelve windows as built). That is a floor close to today's label paths, not a quality fix.
- No new permissions, no SDK, no bundler, no WebAssembly. The package grows by 4 to 5 MB.

## Evidence

Twelve synthetic windows, 906 tabs: eleven of 54 to 82 tabs and one of 200. Two are mostly not in English and one is deliberately messy. 802 tabs belong to a gold task and 104 are loose. The gold groups of ten windows were written by workers from two model families (five by Claude, five by GPT) and the two pilot windows by the plan's author. Tab order does not follow the gold groups.

Two scores, both pairwise F1 (`eval/scoring.mjs`):

- **All tabs**: the answer as the product would apply it (each tab once, at most ten groups, Review Later and left-out tabs ungrouped), scored over every tab, so a loose tab put into a group counts against it.
- **Tasked**: pairs among the tabs that belong to a task, with the answer scored as given. This is the pilot's measure and the one the gate was written against.

The plan prompt was drafted on the two pilot windows and its example folder name is one of their gold groups, so the table uses the other ten. Local settings are chosen leave-one-window-out. Each model row is two answers per window from the Claude API, with no failed request. Time and cost are over all twelve windows. Commands are in `eval/README.md`; `eval/results/rescore.md` holds this table with the twelve-window figures beside it.

| Path | All tabs | Tasked | Time per window, p50 (p90) | US cents per window |
| --- | --- | --- | --- | --- |
| Rules only: Offline smart mode today, and what a click shows when the model is late | 0.18 | 0.25 | milliseconds | 0 |
| Gemini Nano labels through today's planner (nine windows, model warm) | | 0.40 | 15.7 s | 0 |
| Claude Haiku 5.5 labels through today's planner (about 80% of labels match the gold category) | 0.40 | 0.43 | 2.1 s (2.9 s) | 0.21 |
| Gold categories through today's planner (a control) | 0.40 | 0.43 | | |
| Local, no model file: clusters over title-word overlap | 0.33 | 0.35 | under 10 ms for 200 tabs | 0 |
| Local with static embeddings added (4M table, 3.9 MB) | 0.37 | 0.40 | under 25 ms for 200 tabs | 0 |
| Plan request, Haiku 5.5, thinking off | 0.59 | 0.63 | 2.0 s (2.9 s) | 0.06 |
| Plan request, Haiku 5.5, thinking at low effort | 0.79 | 0.82 | 9.1 s (12.6 s) | 0.16 |
| Plan request, Sonnet 5.5, thinking off | 0.80 | 0.85 | 2.9 s (5.3 s) | 1.1 |
| Plan request, Sonnet 5.5, low effort | 0.83 | 0.87 | 2.8 s (3.3 s) | 1.1 |
| Plan request, Opus 5.5, low effort | 0.87 | 0.90 | 3.0 s (4.9 s) | 2.2 |

What this shows:

1. **Correct categories are not enough.** Given the gold category of every tab, today's planner scores 0.40: the 23 categories do not say which tabs belong to one task. Haiku labels about 80% of tabs correctly and scores the same. The row is a control, not a limit of the planner: category keys misused as task ids would score far higher, but a model asked for categories cannot know to do that.
2. **One plan request beats label requests.** Paired on Haiku with thinking off, labels score 0.40 and a plan 0.59, better on all ten windows, in the same time, for a quarter of the cost. The gold-category control is below every plan row, so a better labelling model would not close the gap. Label requests were not run on Sonnet or Opus.
3. **Quality costs time or money.** Haiku is fast or good, not both: 0.59 in 2 seconds, or 0.79 in 9 seconds with about 2,000 thinking tokens per window. Sonnet scores 0.80 to 0.83 in about 3 seconds for about a cent, Opus 0.87 for about two. At low effort Sonnet and Opus used no thinking tokens, and the two Sonnet rows are too close to rank.
4. **Answers break the contract, small models most.** Of 24 Haiku answers without thinking, 10 left tabs out (up to 75 of 200), 9 placed a tab twice and 1 used an id that does not exist. Sonnet left tabs out in 2 of 48 answers (39 of 200 once) and placed a tab twice in 3. Haiku with thinking returned eleven folders once. All 24 Opus answers were valid. Two answers for the same window agree with each other at 0.69 for Haiku without thinking, 0.86 to 0.93 for Sonnet and 0.95 for Opus.
5. **The local engine is a floor.** With the 4M table and one fixed setting it scores 0.37: twice the rules, close to the label paths, and far below any plan request. On the tasked measure over all twelve windows, the figure to hold against the gate, it scores 0.42, and the best single setting found in-sample scores 0.43. Title words alone score 0.33, so the table is worth 0.04 to 0.07 depending on the measure. The two mixed-language windows score 0.27 (tasked). No classifier trained on 3,800 labelled titles beat plain clusters held-out, and the 8M table is no better. The best transformer pipeline tried (EmbeddingGemma 300M, 196 MB) reaches 0.52 where the 4M table reaches 0.42 (tasked, twelve windows), at 4.9 seconds of CPU per 100 tabs.
6. **Nano does not work as a grouper.** Through today's label design it scores 0.40 at 15.7 seconds per window when warm, and a cold load took 285 seconds on a busy machine. Correct labels would only score 0.43, so no sampling or batching change rescues it. Candidate A as tested (Nano proposes folders, then assigns tabs in batches of 16) scored 0.16, with two 60-second timeouts. Candidate B (names only) was not measured.
7. **A stored plan decays as tabs change.** Take a recorded Sonnet plan (0.84 on all twelve windows) and make 10, 20, 30 or 50% of the tabs new. Attaching the new tabs locally gives 0.80, 0.75, 0.70 and 0.60; leaving them out gives 0.76, 0.65, 0.55 and 0.33. About four in ten loose new tabs are attached to a group they do not belong to. The table makes little difference here: starting from gold groups, title words alone give 0.87 at 20% new and the blend 0.89. Local attach is a holding measure for a few new tabs, not a substitute for a new plan.

Limits. The windows are synthetic, and twelve windows with two answers each is a small sample: gaps of 0.15 or more are safe to plan on, differences under 0.05 are not. Claude models score higher on the windows written by Claude than on those written by GPT (Opus 0.94 against 0.87, Sonnet 0.89 against 0.86, tasked). Only Claude models were measured, directly against the Claude API; the product reaches Claude through OpenRouter and its engine defaults are other providers' small models. Every row scores a complete answer, not a click with its deadline, cache and partial results. Latency is from one machine and network. Nano ran on one machine with Chrome's default sampling, and its raw answers were not kept. Group names were read but not scored. No window had more than 200 tabs. The stored plans in point 7 had seen the tabs that were later hidden, so those figures are still optimistic.

## Gate result

| Criterion | Result |
| --- | --- |
| Model plan: mean F1 at least 0.85 and p50 under 2.5 seconds for 60 tabs on Haiku 5.5 | **Failed.** On the tasked measure Haiku scores 0.63 in 1.9 seconds (windows of 62 to 64 tabs) without thinking, and 0.82 in 8.7 seconds with it. Sonnet scores 0.845 to 0.87 and Opus 0.90, in about 3 seconds. |
| Local floor: mean F1 at least 0.50 with one fixed set of thresholds | **Failed.** 0.42 over the twelve windows; the best single setting in-sample is 0.43. |
| A written choice for every "Phase 0 sets" item | **Met.** See "Choices" below. |

The gate failed as written, so the pilot plan stopped and this is the replan. What survived: per-tab category labels are the cause, and one plan request is the cure. What did not: a small model does not give a good plan in one fast request, and local embeddings do not reach 0.50.

## Phase 1 result

Built: with a cloud engine or Ollama in By task mode, a cleanup sends one plan request for the window (`planWindowWithCloud`), repairs the answer under the scoring policy (`enforcePlan`) and applies it. The click waits up to 6 seconds. A later answer is stored for the session and offered in the popup; only Apply regroups the strip. A click on an unchanged window sends nothing. Gemini Nano, Offline smart mode, By site mode and Auto-group are unchanged until Phases 2 and 3.

Measured again with the product's prompt, whose example name ("Wedding Plans") is in no evaluation window, so all twelve windows count. Five Claude settings ran interleaved, two answers per window, no failed request (`eval/results/provider/phase1/report.md`). OpenAI's default model ran through the product's own request code (`eval/results/provider/phase1-engines/report.md`).

| Plan request | All tabs, 12 windows | Time per window, p50 (p90) | Per window | Meets 0.75 inside 6 s |
| --- | --- | --- | --- | --- |
| Claude Haiku 5.5, thinking off | 0.64 | 2.2 s (3.3 s) | 0.06 cents | no |
| Claude Haiku 5.5, thinking at low effort | 0.82 | 8.6 s (12.0 s) | 0.16 cents | no (too slow) |
| Claude Sonnet 5.5, thinking off | 0.84 | 2.8 s (6.0 s) | 1.1 cents | yes |
| Claude Sonnet 5.5, low effort | 0.84 | 2.6 s (4.7 s) | 1.1 cents | yes |
| Claude Opus 5.5, low effort | 0.89 | 3.1 s (3.7 s) | 2.2 cents | yes |
| OpenAI gpt-6-luna, no reasoning, priority off | 0.77 | 2.4 s (3.0 s) | 2,200 tokens in, 250 out | yes, at the line |
| OpenAI gpt-6-luna, no reasoning, priority on | 0.74 | 1.8 s (2.2 s) | the same tokens at the priority rate | at the line |

- The two OpenAI rows are one model: the 0.03 between them is noise, so read it as about 0.75. Priority saves about 0.6 seconds a window. The priority setting and the OpenAI default stay as they are.
- The bar's p90 is taken on windows of up to 66 tabs. The 200-tab window took up to 9 seconds on Sonnet; in the product that is a late plan, offered and not lost.
- Reasoning costs the click. With reasoning at low effort gpt-6-luna took 7 to 9 seconds in a pilot and one answer of four was cut off at the output budget, so the plan request now sends each model's lowest effort whatever is saved, and leaves room for reasoning tokens where a model cannot switch them off.
- Raw answers still break the contract and the validator repairs them: Haiku without thinking left tabs out in 6 of 24 answers (91 of 200 once); gpt-6-luna left out one tab in 4 of 48 answers and placed a tab twice in 10.
- In Chrome (Chrome for Testing 158, the unpacked extension, a 55-tab window, a scripted check): one request per cleanup, none on a repeat click, a late plan offered and applied only by Apply, a changed window refused, a provider error falling back, and nothing stored for an incognito window. With Claude Sonnet answering behind the Ollama engine, the window was grouped in 2.5 seconds into six named task folders and Review Later.

Not done in Phase 1:

- **Other engines are unmeasured.** Gemini, Groq, OpenRouter, DeepSeek and Cerebras have no API key to measure with, and the xAI key has no credit. Their default models are unchanged and unproven on a plan request. The small-tier results above (0.64 and about 0.75) say a default small model gives a plan that is better than labels (0.40) and worse than a mid-tier model.
- **Models that can run without reasoning but are sent low effort.** The request uses the effort list the settings page offers, so some models (GPT-5.2, Gemini 2.5 Flash) still reason a little on a click. This waits for keys to measure with.
- **Auto-group still labels in the background.** With Auto-group on, the background classifier sends label requests as tabs open, as before. Phase 2 replaces it with the local attach.
- **The local result is still the rule cascade.** A late or failed plan, Offline smart mode and incognito show today's local grouping (0.18) until Phase 2 builds the local engine.
- Two independent reviews of the change were run on the other provider and their findings repaired; the rulings are in the project records.

## Phase 2 result

Built:

- **Local engine** (`src/local-engine.js`): average-linkage clusters over title-word overlap, with static embeddings added when the bundled table is loaded. The ten largest clusters of two or more tabs become groups and the rest go to Review Later. It gives the click's result in Offline smart mode and whenever a model plan is late, fails or is not allowed (incognito). Names come from the site table and vocabulary by majority, then the group's shared title words.
- **Embedding table** (`models/potion-base-4M.int8.bin`, 4.1 MB, MIT): built by `scripts/build-embedding-table.mjs` from `minishlab/potion-base-4M` with checksums in `models/potion-base-4M.json`, read by `src/embedder.js` with no dependency. The store archive grows from 0.2 MB to 3.9 MB.
- **Plan upkeep**: on a cloud engine or Ollama, a click on a window whose stored model plan has at most 10% new tabs sends no request. New tabs join the live group they match or Review Later, tabs already in groups stay where they are, and the count runs against the last model plan, so additions accumulate until a new plan is due.
- **Auto-group** attaches a new tab to an existing group locally, on every engine, or leaves it alone. With a cloud engine or Ollama selected the background sends no provider request at all.

Measured (all tabs, twelve windows unless stated):

| Path | F1 | Notes |
| --- | --- | --- |
| Rules only, the local result before Phase 2 | 0.18 | |
| Local engine, title words only | 0.34 | the fallback when the table cannot be read |
| Local engine with the table | 0.39 | 0.36 to 0.37 on the ten windows of the Phase 0 table |
| Model plan, Sonnet 5.5, fresh | 0.84 | from Phase 1 |
| The same plan with 10% new tabs attached locally | 0.79 | 0.75 if the new tabs are left out |
| With 20%, 30%, 50% new tabs attached | 0.72, 0.66, 0.53 | 0.65, 0.54, 0.35 left out |

- The engine in the extension matches the evaluation prototype tab for tab on all twelve windows. With the table, a 200-tab window is embedded and planned in about 20 ms in Chrome (18 and 24 ms median in two runs; table load 7 to 9 ms); the whole Offline click on 200 tabs takes 0.3 to 0.5 seconds.
- The table's vectors match the reference Python tokeniser and model at cosine 0.99997 or better on 49 of 50 test texts; the fiftieth holds a 45-letter word, which the embedder now skips (words over 40 characters are not searched, so a hostile title cannot stall a click).
- Upkeep was measured from 48 Sonnet plans that never saw the new tabs (`eval/results/provider/phase2-upkeep/report.md`). The decay is steeper than Phase 0's optimistic figures from 20% on. At 10% attaching costs 0.045 against a fresh plan and at 20% 0.11, so the rule "new plan past 10% new tabs" stands.
- Attach uses title words only, at 0.05. It scores the same as the table at its best threshold and makes half as many wrong attaches: of new tabs that belong to a task about four in ten join the right group, one in twelve joins a wrong one and the rest wait in Review Later; about one loose tab in five is attached wrongly.
- When the table puts more than half a window into one group, the engine uses title words for that window. This happens on the two mostly non-English windows (84% and 91% in one group), where title words score the same with a largest group of 16% and 28%. The twelve-window figure moves from 0.390 to 0.387.
- Small windows with the table (`eval/results/local-variants.md`): 8 tabs 0.34 with a quarter of the tabs in Review Later, 15 tabs 0.34 with a sixth; the old rules score 0.12 and 0.15 there. These were measured before the half-window rule above was added.
- Local names were read on all twelve windows. Most say what the group is ("Tidewater", "Hearth Rye", "Offline Mode", "Slimline Dishwasher", "Primary School"); some are thin ("Status", "Quotes") and "Folder" is the last resort for a mixed group. Names are not scored.
- In Chrome (Chrome for Testing 158, the unpacked extension, scripted): Offline smart mode groups a 55-tab window with no request and the packaged table loaded; an upkeep click sends nothing and a click past 10% sends one request; Auto-group attaches a related tab, leaves an unrelated one alone and sends nothing, with background preparation on as well.

Not done in Phase 2, or weaker than hoped:

- **The floor is still a floor.** 0.39 against 0.84 for a model plan, weaker on the two mostly non-English windows (0.19 and 0.22), and about one tab in six waits in Review Later (one in three on title words alone).
- **Upkeep leaves most new tabs for Review Later.** That is the stricter attach: a tab left alone is cheaper than a tab in the wrong group, and a new plan arrives past 10%.
- **Gemini Nano still labels on a click** and in the background for its own click; Phase 3 moves its users to the local engine.
- **The label pipeline's code is still present** for Nano; Phase 4 removes it. The settings page still describes background preparation as it worked before; Phase 5 rewrites the copy.
- An independent review on the other provider found nine consequential issues (Auto-group moving a tab after the user had acted, upkeep undoing hand moves, a request below the 10% line, a click stalled by hostile titles); they were repaired and confirmed in two rounds. The rulings are in the project records.

## Phase 3 and 4 result

Built:

- **Gemini Nano is no longer an engine.** A saved Nano choice becomes Offline smart mode the first time settings load after the update (in the worker on install and in every surface), with its setup choice; Nano's timing memory and the background preparation setting are removed. The popup's setup card offers Cloud AI and Offline smart mode (plus Keep Ollama where it applies). Settings has no Nano panel; Ollama on this device keeps its model memory setting. A saved engine value that names no engine runs as Offline smart mode, never as a request.
- **The per-tab label pipeline is gone:** label prompts, schemas and batches, the label cache, the background label queue, the rule cascade that built groups from labels, and model naming and consolidation. The product code is about 5,600 lines smaller and the test suite about 2,700. The label cache and the Cloud economy setting are removed from storage on update. Remembered names, stored plans, offers, rules and old diagnostics records keep working.
- What a click can send is now one plan request per window on a cloud engine or Ollama, and nothing on Offline smart mode, By site mode or in the background. Test connection in Settings sends one plan request and passes only when the answer survives the same validator a cleanup uses.
- `eval/` scripts for the plan request, the local engine and upkeep still run; those that reproduce the label, rules and Nano baselines stop with a message naming commit `c669dcb`, where they still run. Recorded results are unchanged.

Checked: 306 tests; the local engine scores as before (0.3415 and 0.3874); the store archive is 3.9 MB; in Chrome (scripted, headless) 136 checks pass twice, including the Nano migration on a stale profile, the setup card, the Settings page, Test connection and a quiet background. An independent review on the other provider found three consequential issues (the migration could overwrite an engine chosen during it; a cached result could put a user's rename on the wrong group; an Auto-group placement could outlast Cleanup, Apply or Ungroup) and three minor ones; all were repaired, the rename rule in a second round.

Not done: documents, store text, the changelog and the remaining Settings copy (Phase 5).

## Phase 5 result

Foldnex 2.1.0 is the release candidate: version, changelog, README, user guide, product contract, privacy page, terms, store listing text and data disclosures, Settings and popup wording, and store screenshots now describe the product as built. Product links moved to `https://magrathean.uk/solutions/foldnex/`. Foldnex's own licence is packaged beside the word table's.

Two independent reviews on the other provider shaped the release. A documents review checked every disclosure against the code and led to more exact wording throughout. A security review found no critical or high issue; its findings were fixed before release:

- **Private windows send nothing.** A private window always uses the local engine on every engine setting. This replaces the Phase 1 rule, under which a private cleanup could send one plan request.
- **Keys and tab data reach only their own provider.** Cloud engines always use their own address; an Ollama address must be on this device or HTTPS, with no credentials, query or fragment; provider requests follow no redirects.
- Identifiers in addresses are masked before the hint is shortened; diagnostics keep the configured model, not the provider's reply; console messages carry no group names; a provider answer's size is bounded relative to the tabs sent.
- Evaluation fixtures and the title corpus use reserved domains and dummy identifiers for personal-looking values. The local engine scores 0.34 on title words and 0.39 with the table after the change.

Checked: 315 tests; the store archive is 3.9 MB; the scripted Chrome check passes in headless Chrome.

## Target design

### 1. Model plan: the fix

- Cloud engines and Ollama get one request per window: the same rows as today's label request (id, title up to 160 characters, site/path hint) and the answer `{"folders":[{"name","ids"}]}`. The schema is constant. The prompt measured in Phase 0 is in `eval/probe-llm.mjs`; its example folder name is replaced by one that is in no evaluation window before the next measurement.
- The answer is validated and repaired locally by the rules the evaluation scores: first placement of a tab wins, unknown ids are dropped, at most ten groups, names through `validateGroupName`, tabs the model left out attached locally or sent to Review Later. Rules and Socials stay locked and are never sent. Colours are assigned locally.
- The click waits up to 6 seconds for the plan and applies it once. If the plan is late, the local result is applied, the plan is stored, and the popup offers it. A late plan never regroups the strip on its own.
- Data sent is the same in kind as today (titles and site hints). The per-tab label request, its schema and its batches go away.

### 2. Plan memory and local upkeep

- A stored plan is reused while the window is unchanged: a repeat click makes no request and gives the same grouping.
- With up to 10% new tabs, a click attaches them to the plan's groups by similarity and makes no request. Past 10% it requests a new plan.
- Auto-group new tabs uses the same local attach for every engine, so it no longer sends each new tab to a cloud provider.
- The per-tab label cache, its engine scopes and the background label queue are removed once nothing reads them.

### 3. Local engine: the floor

- Grouping is average-linkage clustering over title-word overlap plus embedding similarity, with one fixed setting for every window. No classifier and no larger embedder.
- `src/embedder.js` loads a bundled int8 table (`potion-base-4M`, MIT, 3.9 MB), tokenises with WordPiece and averages token vectors, with no dependency. The prototype in `eval/lib.mjs` matches the Python reference at cosine 1.0000.
- The table is built second. It adds 0.04 to 0.07 on a click and almost nothing to upkeep, and it stays because it puts the offline mode level with Nano, which this plan removes. If its size or loading becomes a problem, the engine works on title words alone at 0.33.
- Names and colours for local groups come from the existing site table and vocabulary by majority within the group, with the group's most distinctive title words as the fallback.
- It replaces the rule cascade wherever no model plan is available: Offline smart mode, incognito, a provider failure, a late plan. It also does the attaching in section 2.

### 4. Gemini Nano

Nano leaves grouping. It gives the quality of the local engine in 16 seconds a window where the local engine takes milliseconds, and holds a 3 GB model to do it. Candidate A is rejected as tested. People who chose Nano get the local engine. A names-only role (candidate B) is built only if the local names prove poor and Nano's names test better on the evaluation windows.

### 5. Provider requests

- Reasoning stays at the lowest effort on every engine, and small models do not think on the click path.
- No provider SDK. Claude stays reachable through OpenRouter. A direct Claude engine needs a new host permission and is not part of this plan.
- `prompt_cache_key` is removed: the plan prompt is below the size OpenAI caches from.

### Choices Phase 0 was asked to make

| Item | Choice | Evidence |
| --- | --- | --- |
| Largest window for one request | 200 tabs measured; larger windows are sent the same way and treated as a late plan if they miss the click budget | 200 tabs took 4.5 to 6 seconds on Sonnet and Opus; without thinking, Haiku and Sonnet each dropped tabs there |
| Share of new tabs that triggers a new request | More than 10% | Recorded Sonnet plan: 0.84 fresh, 0.80 with 10% new tabs attached, 0.75 with 20% |
| Click budget for the plan | 6 seconds (4.5 today) | p90 at about 60 tabs is 3.1 to 3.6 seconds on Sonnet and Opus at low effort |
| Gemini Nano | Out of grouping | 0.40 at 15.7 seconds; candidate A 0.16 |
| Reasoning effort | Lowest on every engine | Sonnet and Opus answer at low effort in about 3 seconds; thinking costs Haiku 7 seconds |
| Priority processing (OpenAI) | Unchanged until measured in Phase 1 | Phase 0 measured Claude only |
| Embedding table | 4M, built after the title-word engine | Title words 0.33, with the 4M table 0.37; the 8M table is no better |
| Engine default models | Measured per engine in Phase 1 before any default changes | The Claude small tier scores 0.59, the mid tier 0.80 or more |

## Build and drop

Build, in this order: the model plan request with a stored plan (the quality fix); the local engine with upkeep (the floor, and what spares a request when little has changed); then removal of what they replace.

Drop: per-tab label requests and everything that serves them; Gemini Nano as a grouping engine, and candidate A; the trained classifier (the title set stays as evaluation data); the 8M table and every transformer embedder; thinking on small models during a click; a direct Claude engine in this plan; the 0.50 target for the local engine.

## Phases

Each phase is one worker brief with the checks below. A phase starts only when the one before it has passed.

**Phase 0: evidence.** Done. The gate failed as written and the plan above replaces the pilot. An independent review of `eval/` found the decision sound and the first reports overstated; its corrections are in `eval/results/rescore.md` and in this document.

**Phase 1: model plan for cloud engines and Ollama.** Done, with two items open: see "Phase 1 result". `src/ai-engine.js`, `src/grouper.js`, `src/planner.js`, `src/cache-engine.js`, popup result states, engine runners in `eval/`.
- One request per cleanup. The product's validator applies the rules `eval/scoring.mjs` scores, and the recorded Phase 0 answers (tabs left out, tabs placed twice, unknown ids, eleven folders) replay through it in tests, with malformed and hostile ones. Done.
- The prompt's example name is replaced and the Claude rows are run again on all twelve windows, with settings interleaved and matched by window size. Done.
- A repeat click on an unchanged window makes no request and gives the same result. A late plan is stored and offered, never applied silently. Incognito keeps its current boundaries. Done, and checked in Chrome.
- Each engine's default model is measured on the twelve windows with that provider's key. An engine default is the cheapest model that scores 0.75 on all tabs with p90 inside the click budget. The OpenAI priority setting is measured the same way. Done for OpenAI only; the other engines wait for keys.
- Network and schema change: reviewed on the other provider before merge. Done, twice.

**Phase 2: local engine and plan upkeep.** Done: see "Phase 2 result". `src/local-engine.js`, `src/embedder.js`, the model file and its build script with checksum and source, `src/grouper.js`, `src/background-classifier.js`, `scripts/package-store.sh`, third-party notice.
- The title-word engine first: Offline smart mode and every fallback path use it, at 0.31 or more on all tabs with one fixed setting. Then the table: vectors match the reference Python implementation (cosine at least 0.99 on a test list) and the score reaches 0.35 or more. A 200-tab window plans in under 100 ms in the extension. Done: 0.34, 0.39 and about 20 ms.
- New tabs join a stored plan with no provider request, and a click requests a new plan only past 10% new tabs. Upkeep is measured again from plans that never saw the new tabs, and the threshold is confirmed or moved. Done: confirmed at 10%.
- Auto-group new tabs uses the local attach for every engine. Local group names are read on all twelve windows. Done.
- Existing contract tests still pass: every tab once, ten-group limit, locked groups, determinism. Done.

**Phase 3: Gemini Nano out of grouping.** Done: see "Phase 3 and 4 result". The Nano engine, its batch sizing and the held model are removed; its users move to the local engine. Setup card and Settings copy updated.

**Phase 4: removal.** Done: see "Phase 3 and 4 result". Delete label prompts, the label schema and batches, the label cache and the background label queue; tests rewritten for what remains.

**Phase 5: documents and release candidate.** Done: see "Phase 5 result". `docs/architecture/product.md`, user guide, privacy page, changelog, store text, version. Manual check in Chrome of the popup, shortcuts, incognito, duplicates, Auto-group and each engine. Publishing to the Chrome Web Store stays a manual release step.

## Decisions taken

- Replace per-tab category labels with one model plan request per window, and a local engine as the floor.
- The plan request comes first, because it is where the quality is; the local engine follows.
- The local engine is plain clustering over title-word overlap and the 4M static table. No classifier, no 8M table, no transformer embedder, no SDK, bundler or WebAssembly.
- Gemini Nano leaves grouping.
- A late model plan is offered in the popup and never regroups the strip on its own.
- Engine default models and the OpenAI priority setting change only on measurements made with each provider's own key.
- Results are quoted over all tabs on the ten windows the prompt was not drafted on.

## Risks

- **Small, synthetic sample.** Twelve windows written by models, two answers each. The large gaps (0.18, 0.40, 0.59, 0.80 and above) are safe to plan on; the order of the Sonnet settings is not.
- **Other providers are unmeasured.** The engine defaults are small models from other providers. On Claude the small tier scores 0.59 and breaks the answer contract in half its answers. Phase 1 measures each engine before a default is chosen; until then the only claim is that a plan request beats labels.
- **Cost on a mid-tier model.** About a cent per window against 0.2 cents for labels today, and a new request past 10% new tabs. The model stays the user's choice.
- **Latency above the pilot target.** About 3 seconds for an ordinary window and 5 to 6 for 200 tabs. Past the 6 second budget the local result shows and the plan is offered.
- **A new plan can reshuffle groups.** Two answers for one window agree at 0.86 to 0.95 on Sonnet and Opus. The stored plan keeps the strip steady between changes; Phase 1 checks how a new plan reads next to the old one.
- **The floor is modest and English-centred.** 0.37 overall, and weaker still on the two mixed-language windows. It is the offline mode, not an equal of a model.
- **Local attach misplaces tabs.** Four in ten loose new tabs join a group they do not belong to. Phase 2 measures a stricter attach before Auto-group relies on it.
- **Local group names are unmeasured.** Phase 2 reads them on every window before they ship.
- **Scale of the change.** The test suite is about 9,000 lines and much of it exercises the label pipeline. Removal is last (Phase 4), after the new paths are proven.

## Evaluation files

`eval/README.md` lists the data, the scripts and the scoring policy. In short: `eval/fixtures/` holds the twelve windows and `eval/data/titles.jsonl` the labelled titles; `eval/run-local.mjs` runs every model-free variant; `eval/run-provider.mjs` runs the Claude API rows; `eval/nano/` is the page that drives Gemini Nano in Chrome; `eval/local-embedders.mjs` compares embedder pipelines and `eval/local-ablation.mjs` separates the title-word and embedding channels; `eval/rescore.mjs` scores every recorded result under one policy. `eval/probe.mjs` and `eval/probe-llm.mjs` are the pilot, kept for comparison.
