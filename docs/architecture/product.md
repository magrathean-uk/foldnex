# Foldnex product contract

<!-- impeccable:product-schema 1 -->

## Platform

Chrome extension using Manifest V3, with no build step and no runtime package dependencies.

## Users

Chrome users with crowded windows who want to restore a usable tab strip without manually finding duplicates or sorting every page.

## Product purpose

One action should leave the current window visibly cleaner: a single sensible copy of each ordinary web page and a small number of task-oriented Chrome tab groups.

## Positioning

Foldnex is a practical tab-organisation utility, not an AI showcase. It combines conservative duplicate removal, exact semantic result reuse, explicit user rules, optional AI labelling with local planning, and an offline fallback.

## Primary surfaces

- **Popup:** tab count, cleanup action, ungroup action, a first-run setup card until an engine choice is saved, grouping strategy, active task engine, local-memory summary, and direct-toolbar preference.
- **Options:** one provider list with a shared configuration panel, background work and model memory for on-device engines, rules and semantic-memory management, privacy-safe run diagnostics, and behaviour preferences.
- **Toolbar and commands:** progress/result badge plus group and ungroup keyboard shortcuts.

## First-run setup

- The popup shows a setup card below the cleanup action until `setupChoice` (`cloud`, `nano` or `offline`) is saved in sync storage. New installs and installs updating to 2.0 both see it the next time the popup opens; with **Run from toolbar** on, the toolbar icon keeps opening the popup until `setupChoice` is saved and only then runs cleanups directly. Nothing warms Gemini Nano before then. It never blocks or disables **Clean up and group**. The saved engine is marked Current: an earlier version's choice, or on a new install the Gemini Nano default that the service worker saves at install.
- **Cloud AI** selects the first cloud engine with a saved credential: the current engine, then OpenAI, then the rest in catalog order. It checks only that a credential exists in local storage and never shows it. Without one it saves only `setupChoice` and opens Settings at `#engine`, reusing an open Settings tab. Settings then previews OpenAI with its key field focused and says that the saved engine stays in use; saving a key for the previewed cloud engine selects it.
- **On this device — Gemini Nano** selects Gemini Nano and turns on background preparation. The choice is disabled with Chrome's reason when the Prompt API reports the model unavailable. When Chrome still needs to download the model, the choice is saved and Settings opens so the download can start.
- **Offline — no AI** selects Offline smart mode.
- When Ollama is the saved engine, a fourth choice, **Keep Ollama**, leaves the engine and background preparation unchanged and saves `nano` for Ollama on a loopback address, otherwise `cloud`. For Ollama at another address its copy says that page titles and a short site hint are sent to that server.
- The card's copy states the on-device memory cost (about 3 GB while the model is loaded), the current unload setting, and the 15-25 second first load, and says that the Cloud choice sends page titles and a short site hint to the provider.

## Core workflow

1. Resolve the active Chrome window and its incognito boundary.
2. Remove duplicate ordinary web pages and allowlisted stateless Chrome pages using a conservative canonical URL.
3. Exclude pinned and browser-internal tabs from grouping.
4. If By site category is selected, classify locally from the address using the stable service taxonomy and site-name fallback.
5. Otherwise lock explicit user-authored URL rules first, then Socials, and reuse a cached result only when the complete semantic tab set is unchanged. Every other tab needs one category label from a fixed vocabulary of 23 keys. Labels come from the per-tab label cache (keyed by a title and URL fingerprint, kept seven days) or from the selected engine within one click budget of about 4.5 seconds: Nano labels batches sized to its measured speed, and cloud engines receive one request up to 40 tabs, then parallel batches of 25. The model only labels; it never chooses a group count or creates a group.
6. Tabs the engine could not label before the deadline are placed provisionally from their site, a labelled neighbour on the same site, or title words. Provisional tabs are reported and never cached. An on-device engine labels them in the background right after the cleanup, even with background preparation and Auto-group off. With a cloud engine, a batch that answers after the deadline is cached for the next cleanup, and the background retries only tabs that **Auto-group new tabs** covers.
7. The local planner turns labels into groups within the ceiling, assigns every tab exactly once, and names groups deterministically. Remembered names apply first (user renames, then earlier model names). When fewer than half of the groups have a remembered name and time remains, Nano may name them in one prompt, or a cloud engine or Ollama may consolidate the candidate groups into named folders. A prepared window, whose labels all came from the cache, waits at most `PREPARED_NAMING_WAIT_MS` (1.2 seconds) for that answer; other windows wait while the budget allows. A late answer is remembered for the next cleanup and never regroups the strip.
8. Apply exact scoped rename preferences, then the group ceiling once more as a safety net.
9. Create groups in their existing left-to-right order and report privacy-safe diagnostics.

## Background classification

- Background work is opt-in. It runs only under the consent rules below and while **Prepare groups in the background** (`backgroundPrep` in sync storage, off when unset) or **Auto-group new tabs** is on. The one exception is a cleanup's follow-up: with an on-device engine, the tabs a cleanup placed by address are queued with reason `cleanup` (the `cleanupFollowUp` scope) and labelled even with both off, with no plan refresh or naming, and then background work stops. The queue checks this before each labelling batch and each plan refresh; the service worker checks it before queueing open tabs, handing over a cleanup's provisional tabs, and moving the popup's window to the front.
- When a tab finishes loading, the service worker queues it and labels it after a short delay, storing each batch as it lands, so a later cleanup only applies cached labels. A busy queue still flushes within about 5 seconds of its first tab. Discarded and not-yet-loaded tabs are labelled from their saved title; a tab that is still loading waits for its load.
- With an on-device engine, the tabs a cleanup placed provisionally are queued the same way, even with background preparation and Auto-group off, and the popup says they will be sorted in the background. While background work is allowed, so is every open tab in every non-incognito window after a browser start, after an extension install or update, and once when background preparation or Auto-group is turned on. With a cloud engine, provisional tabs that Auto-group does not cover wait for the next cleanup, and the popup says so.
- When a settings change means background work is no longer allowed (background preparation and Auto-group both off, or an engine or strategy change), the service worker stops the running batch and drops queued tabs, pending retries and plan refreshes.
- A title-only change, or an address change within the same page (a fragment, or a map or app rewriting its address), re-labels a tab at most once every 10 minutes until the tab opens a new page. A tab that comes back unlabelled is retried after 5 seconds, 30 seconds and 2 minutes; after four failed attempts it waits until it opens a new page, and a cleanup that places it provisionally, or with an on-device engine opening the popup, tries it once more.
- A few seconds after a window's last new label, the service worker refreshes that window's plan, postponing it by at most about 15 seconds. With an on-device engine it may name the plan's groups, Nano by naming and loopback Ollama by consolidation (at most once per window every 30 seconds, and only when the plan changed), so the next cleanup needs no model call.
- Opening the popup warms Nano when it is the selected engine for By task and `setupChoice` is saved, unless the unload setting is `immediately`, which would release the model 6 seconds after its load. Nothing warms Nano before the setup card is answered. While background work is allowed, opening the popup also moves the current window's tabs to the front of the queue for an on-device engine. A browser start, an install or update, and a service-worker start warm Nano only while background preparation or Auto-group is on.
- Chrome Gemini Nano and Ollama on a loopback address (`localhost`, `127.0.0.1` or `[::1]`) need no cloud consent because tab data stays on the device. Beyond a cleanup's follow-up, they label in the background only after the user turns on background preparation, in Settings or by choosing Gemini Nano in the setup card, or turns on Auto-group. Auto-group needs labels, so while it is on with an on-device engine, background preparation stays active and Settings says so. Ollama at any other address counts as a cloud engine.
- Cloud engines label in the background only when the user turns on **Auto-group new tabs**, and then only tabs opened or sent to a new page after it was turned on, as its setting states. Background preparation never enables cloud background labelling. Tabs that were already open, title or in-page address changes after a page's first 10 seconds, popup opens and browser starts send nothing. Background cloud batches are sent one at a time, and background runs never make cloud consolidation requests.
- With **Auto-group new tabs** on, a tab opened or sent to a new page while the setting is on is filed as it loads. Tabs Chrome restores in the first 20 seconds after it starts, or restores without loading, are not new. The tab joins the Chrome group that already holds most of its planned group's tabs, or a group with the same name when none of them is grouped. A new group forms only when no tab of that planned group is grouped yet (Review Later aside), two such tabs share it, and the window still has fewer titled groups than its ceiling.
- A tab the user takes out of a group, or that **Ungroup current window** (or its shortcut) ungroups, stays out until it opens a new page; an address change within the same page does not count. Only a new tab's own load starts an auto-group; opening the popup, a cleanup, and other tabs' reloads or title changes never do. Explicit URL rules and Socials take precedence, Review Later is never auto-created, and grouped tabs are never moved. A cleanup or an ungroup cancels an auto-group in progress before its next change; a group it has just created still gets its name.
- Incognito tabs are never classified in the background.

## On-device model memory

- While Foldnex holds a Gemini Nano base session, Chrome keeps the model loaded. In a measured test on an Apple Silicon Mac, that took about 3 GB of memory, and a cold load took 15-25 seconds.
- `modelUnloadAfter` in sync storage (`immediately`, `2m`, `5m`, `15m`, `60m` or `never`; `5m` when unset or unrecognised) sets how long Foldnex holds an idle model. Creating or reusing a base, a warm, and a prompt each restart the idle clock. A load, a prompt, or a whole labelling run in progress holds the model, so it is never released mid-run. One timer, re-armed from the last use, releases the base sessions once the model has been idle longer than the setting. `immediately` waits a 6-second grace so a naming prompt right after labelling, in a cleanup or in the background plan refresh about 4 seconds after the last label, does not reload the model. `never` holds it only while Chrome keeps the service worker running. A changed setting applies at once, so a model already idle long enough is released straight away.
- Once Foldnex lets go, Chrome frees the memory itself; in the same test that took about 5 minutes after the last use. Labels stay cached, so only unlabelled tabs need the model loaded again.
- Switching the engine away from Gemini Nano releases the sessions. The service worker first pauses background work for up to 1 second, so a running batch cannot load the model straight back.
- For Gemini Nano, Settings shows **Background work and memory**: the background preparation switch, the unload setting, a model-state line refreshed at most every 5 seconds while the engine page is visible, and **Free memory now**. For Ollama on a loopback address it shows only the switch. The service worker answers `GET_ON_DEVICE_MODEL_STATE` with `{ ok, loaded, idleMs, unloadAfter }`, where `idleMs` is 0 while the model is in use and `null` when it is not loaded. It answers `UNLOAD_ON_DEVICE_MODEL` with `{ ok, released }`. Releasing pauses background work for up to 1 second, and if background preparation still has tabs queued, the next batch loads the model again.
- Requests to Ollama on a loopback address carry the same setting as Ollama's `keep_alive`: `0` for `immediately`, the same duration string from `2m` to `60m`, and `-1` for `never`. Ollama 0.35 and later apply it on the OpenAI-compatible endpoint Foldnex uses; earlier versions ignore the field and keep their own default. `0` unloads the model after every request, so each background batch reloads it. Ollama at another address and cloud providers never receive it.

## Duplicate-survivor contract

- Ignore ordinary document anchors but preserve route-like fragments.
- Keep HTTP and HTTPS identities distinct.
- Retain query keys, values, order, host, port, and path.
- Prefer a pinned survivor, then the active tab, then the leftmost copy. A redundant pinned copy can close when the survivor is still pinned.
- Recheck both survivor and candidate immediately before removal.
- Deduplicate exact URLs for a short allowlist of stateless Chrome pages; preserve other non-HTTP(S) pages.

## Grouping contract

- **By task** uses each title, capped at 160 characters in prompts, as the primary semantic signal and its sanitised URL as supporting context.
- **By task** groups by active task or purpose, not simply by domain or media type. A title word shared across several categories and sites (for example a trip or a product) becomes its own task group.
- **By site category** uses only the address and makes no model request. Known services use a maintained service taxonomy. X, Reddit, and Slack are Socials; Gmail and Outlook are Email; assistants such as ChatGPT and Grok are AI · Assistants; AI provider consoles and documentation are AI · Platforms. AI groups never merge into Code, Cloud, or generic technology groups.
- In either strategy, known social services are kept in Socials rather than accepted inside system or administration groups. Explicit user-authored URL overrides still take precedence.
- By site category keeps every page under the same recognised base site together, including separate Envato account, asset, and content areas.
- YouTube, Envato, and Tesla are atomic dedicated groups. A multi-service category exceeding 15 tabs splits deterministically at service boundaries with namespaced labels such as Socials · X and AI · ChatGPT.
- Repeated unknown sites use a readable site name. One-off unknowns enter Review Later groups capped at eight tabs rather than producing one group per tab or one unbounded catch-all.
- Produce concise names and only Chrome-supported colours.
- Assign every current groupable tab exactly once.
- In By task mode, the group count never exceeds `groupCeiling(n)` in `src/ai-engine.js` for n groupable tabs: 1 group for 2-3 tabs, 2 for 4-5, 3 for 6-7, 4 for 8-12, 5 for 13-17, 6 for 18-24, 7 for 25-31, 8 for 32-40, 9 for 41-49 and 10 from 50 tabs. It is a ceiling, not a quota: a less varied window gets fewer groups, and there is no minimum.
- In By task mode, a category group is kept on its own from `minGroupSize(n)` tabs (2 up to 12 tabs, 3 up to 40, then 4). Smaller groups join a closely related group; a single tab in a window of 8 or more always joins one. Above the ceiling the closest pair by category affinity and size merges, named 'A & B' when neither side dominates.
- The only exception to the ceiling: when explicit rule groups and Socials alone reach it, the remaining tabs form one more group and the run is flagged `rules_exceed_ceiling`.
- In By task mode, names are never Other or another vague catch-all. Model and remembered names are validated locally (at most 30 characters and 4 words, not generic, not made only of vague words such as Online or Services, free of decorative words such as Delights, not a bare domain, unique, and not contradicted by a member's country-code domain); a rejected name keeps the deterministic name. A user's own rename is kept as typed: control characters removed, cut to 30 characters at a word boundary, and refused only when it is empty, 'Review Later', or already used by another group in the window. No second model request is ever made to repair a result.
- In By task mode, oversized groups split at a shared title word or site only while the window is below its ceiling. Groups above roughly 28% of ordinary windows or 20% above 80 tabs (minimum cap eight) are flagged as a diagnostic. By site category deliberately permits large same-site groups.
- In By task mode, tabs that neither a label nor local inference can place (after the deadline, or in Offline smart mode) go into one grey Review Later group when there are at least `minGroupSize(n)` of them and the ceiling has room; otherwise they join the closest group. Review Later is never merged into a real group.
- Preserve natural tab order inside groups and group order across the strip.

## Engine strategy

- Local options are Chrome Gemini Nano and offline smart mode.
- Cloud options are Google Gemini, OpenAI, xAI Grok, Groq, OpenRouter, DeepSeek, and Cerebras.
- Ollama uses its fixed loopback endpoint at `http://localhost:11434`.
- By site category is a deterministic local strategy independent of the selected task engine and consumes no provider tokens.
- Site-category grouping does not request browser-history permission. The generic public taxonomy is maintained in source; personal mappings remain explicit local rules.
- Provider model catalogs are discovered live and cached for six hours.
- Settings exposes reasoning effort beside supported models, with Low as the existing default. Label and consolidation requests use the saved effort; cached labels are reused across efforts and models, and a cloud engine reuses only labels a cloud engine wrote. Available levels follow the selected provider and model; unsupported engines show no adjustable level. The popup shows the effective choice, and last-run diagnostics show the effort and any reasoning-token count reported by the provider. Requests use the provider's native parameter shape and omit incompatible sampling controls. Connection tests and grouping use the same rules.
- The OpenAI catalog entry uses `gpt-6-luna` at Low reasoning effort as its default model. **Priority processing** (`openaiPriority` in sync storage, on unless set to `false`) sends `service_tier: "priority"` for lower latency at a higher price. In a measured test with Priority on, `gpt-6-luna` at Low labelled and named 100 tabs on a cold cleanup in 2.6 seconds, and a repeat cleanup took about 5 ms; with Priority off, a cold cleanup reached the 4.5-second budget with half the tabs placed by address.
- The Groq catalog entry uses `qwen/qwen3.8-27b` as its default model. This is a source default, not a current availability or comparative-quality guarantee.
- OpenAI label requests use a strict JSON schema whose values are the fixed category keys when the model supports Structured Outputs and the default OpenAI base URL is used; other OpenAI models use JSON-object output. Consolidation requests follow the same rule, and a request whose schema is rejected is retried once in JSON-object mode. Groq and the other compatible providers use JSON-object output, which avoids strict-schema `failed_generation` errors that can otherwise turn a recoverable answer into an HTTP 400. Every answer gets local ID and category validation. Nano uses a fixed-key schema with no arrays.

## Data and privacy contract

- API keys and bearer tokens live in `chrome.storage.local`, restricted to trusted extension contexts.
- Non-secret engine preferences may sync through Chrome, including `setupChoice`, `backgroundPrep` and `modelUnloadAfter`. None of the three is written by the service worker, and none holds tab data.
- Cloud By task grouping sends titles (up to 160 characters each) and URL host/path hints to the selected provider; URL credentials, query strings, and fragments are removed first. Titles and paths can still contain sensitive information. Consolidation sends at most three member titles per candidate group, shortened to 60 characters, with its category key and tab count. With **Auto-group new tabs** on, the same title and hint of each tab opened or sent to a new page afterwards are sent in the background.
- Local storage keeps per-tab category labels (category key, engine ID, and time under a title and URL fingerprint; seven days, at most 3,000 entries) and group-name memory (category or hashed keys, title-word hashes, names, colours, and for user renames tab fingerprints; user renames 90 days, model names 14 days, at most 120 names and 200 cloud merge-advice pairs). Neither stores titles or URLs, although names can reflect tab content. A reset counter stops writes already in flight from restoring cleared data, and the Nano speed estimate holds two timings. Each window's latest plan (tab IDs, names, colours, and category or hashed keys) lives in session storage only, as does Auto-group's list of tab IDs opened since it was turned on and an address hash for each tab taken out of a group.
- Unpacked development installs keep the latest phase-timing trace of a cleanup and of background work (phase names, timings, counts, window IDs, and the engine and strategy used) in local storage. Store installs and incognito runs never record one.
- By site category, offline smart mode, and a working Chrome on-device model do not make a cloud grouping request. Background preparation applies only to on-device engines and never sends tab data to a cloud provider.
- The setup card's Cloud choice reads local storage only to see whether a credential exists for a cloud engine; that check never displays, syncs or sends the credential.
- Page bodies are never read; there are no content scripts.
- Incognito grouping does not read or write rules, exact results, labels, name memory, window plans, the Nano speed estimate, diagnostics, or group-rename preferences. User changes to shared settings can still persist. If a cloud engine is selected, its normal title and host/path transmission still applies.
- Programmatic group updates are marked in shared session storage and cannot become user corrections.
- Imported rule files are size-limited and schema-validated before storage.

## Chrome on-device constraint

Current Chrome exposes the Prompt API in the Manifest V3 service worker (measured on Chrome 154), so every cleanup and background run uses Nano there. Because a cold load takes 15-25 seconds, the service worker warms the model when the popup opens, and on startup and install only while background preparation or Auto-group is on; it never warms before the setup card is answered or under the `immediately` unload setting. A cleanup never waits for a cold load: it places tabs provisionally, reports that the model is still loading, and the background labels them once it is ready. When the Prompt API is absent or the model is not ready, runs fall back safely to local placement rather than claiming on-device inference occurred.

## Product principles

- One action creates visible order.
- Preserve user context while removing clutter.
- Prefer conservative, recoverable decisions around tabs.
- Keep provider complexity understandable and secondary.
- Make local-versus-cloud behavior explicit.
- Report concrete outcomes rather than generic success.

## Brand commitments

- Product name: Foldnex.
- Visual language: restrained Magrathean/Teslatlas utility design.
- Use system typography, deep navy or clean neutral surfaces, precise spacing, thin rules, and compact actions.
- Avoid generic AI gradients, sparkles, emoji decoration, promotional model artwork, and card-grid settings.

## Acceptance criteria

These are checks for a behaviour change, not a record that the current build passed them.

- Duplicate removal preserves the correct survivor and reports the count.
- Every surviving groupable tab is assigned to a group even when model output is incomplete.
- Pinned, internal, vanished, or newly navigated tabs are handled without destructive assumptions.
- A provider failure produces an offline result and communicates that fallback.
- An unchanged semantic window can reuse a result, while any title or semantic URL change causes fresh classification.
- By site category keeps all Envato pages together, gives YouTube its own group, separates Socials from Email and AI from Code, and makes no provider request.
- A deterministic 200-tab fixture assigns every tab once, produces no more than 30 groups, and repeats the same names and membership on every run.
- By task never exceeds 10 groups, or `groupCeiling(n)` for smaller windows, except the documented rules exception.
- A By task cleanup completes in about 5 seconds and reports how many tabs it placed provisionally.
- Auto-group files only tabs opened or sent to a new page while it is on, joins the group that already holds their planned group's tabs, never regroups a tab the user took out, and with a cloud engine sends only those tabs.
- The setup card shows until a choice is saved, including for users with **Run from toolbar** on, never blocks a cleanup, and a Cloud choice without a saved key leaves the saved engine active.
- With an on-device engine and both background preparation and Auto-group off, the background labels only the tabs a cleanup just placed by address, and nothing is named or warmed in the background; turning them off drops queued work.
- An idle Gemini Nano model is released after the unload setting, never mid-run, and at once on **Free memory now** or a switch to another engine.
- Last-run diagnostics identify the actual engine, source, token usage, latency, groups, duplicates, fallback class, and quality flags without retaining tab content.
- API keys must remain outside sync storage, exported rules, logs, and source control. Check the changed paths; this contract does not certify repository history.
- The popup and settings remain usable with keyboard focus, reduced motion, and narrow widths.
- Current ordinary-user browser behavior is checked separately from syntax and mocked-provider checks.

## Maintained evidence

- Behavior: `background.js`, `src/grouper.js`, `src/planner.js`, `src/label-vocabulary.js`, `src/ai-engine.js`, `src/background-classifier.js`, `src/cache-engine.js`, `src/group-state.js`, `src/debug-trace.js`, and `src/site-clusterer.js`.
- User surfaces: `popup.*` and `options/*`.
- Permissions and entry points: `manifest.json`.
- Product-facing setup and privacy guidance: `README.md`.
- Visual authority: `docs/architecture/design.md`, `popup.css`, and `options/options.css`. The older generated `.impeccable/design.json` describes a superseded palette and must not override these files.
