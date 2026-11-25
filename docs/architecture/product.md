# Foldnex product contract

<!-- impeccable:product-schema 1 -->

## Platform

Version 2.2.0 is a Chrome extension using Manifest V3, with no transpilation step and no runtime package dependencies. `manifest.json` declares Chrome 120 as the minimum browser version. The module service worker is `background.js`, the popup is `popup.html`, and Settings opens `options/options.html` in a tab. The package includes a 4.1 MB word-embedding table (`models/potion-base-4M.int8.bin`, MIT, see `docs/legal/third-party-notices.md`); the store archive is about 3.9 MB.

The extension requests `tabs`, `tabGroups`, and `storage`, plus the seven HTTPS provider hosts and `http://localhost:11434/*`. `https://api.anthropic.com/*` is an optional host permission (`optional_host_permissions`), granted only when the user allows it; it adds no install-time warning. It has no content scripts or browser-history permission. The `tabs` permission exposes tab metadata, and host access permits configured provider requests; neither means page bodies are inspected.

## Users

Chrome users with crowded windows who want to restore a usable tab strip without manually finding duplicates or sorting every page.

## Product purpose

One action should leave the current window visibly cleaner: a single sensible copy of each ordinary web page and a small number of task-oriented Chrome tab groups.

## Positioning

Foldnex is a practical tab-organisation utility, not an AI showcase. It combines conservative duplicate removal, exact result reuse, explicit user rules, an optional model plan of the window (one request) and a local engine that works on every click without a model.

## Primary surfaces

- **Popup:** groupable-tab count, cleanup action, ungroup action, a late-plan offer with **Apply**, a first-run setup card until an engine choice is saved, grouping strategy, active task engine, local-memory summary, and direct-toolbar preference.
- **Options:** three sections, **Grouping engines**, **Rules & memory**, and **Behaviour**. Engines uses a reversible compact chooser, one vertical provider list, shared configuration panels with model catalogs and connection tests, an Offline smart mode panel, and for Ollama on a loopback address a **Model memory** setting. Rules manages explicit URL rules and grouping memory. Behaviour includes strategy, toolbar mode, Auto-group, collapse preference, last-cleanup diagnostics, provider-request totals and keyboard shortcuts.
- **Toolbar and commands:** progress/result badge plus group and ungroup keyboard shortcuts.

## First-run setup

- On install the service worker saves Offline smart mode and By task when no engine is saved. The popup shows a setup card until `setupChoice` (`cloud` or `offline`) is saved in sync storage. With **Run from toolbar** on, the toolbar icon keeps opening the popup until it is saved. The card never blocks **Clean up and group**.
- **Cloud AI** (badge "Recommended") selects the first cloud engine with a saved credential: the current engine, then OpenAI, then the rest in catalog order. It checks only that a credential exists in local storage and never shows it. When the engine it selects is Anthropic, the click also asks Chrome for Anthropic's host. Without one it saves only `setupChoice` and opens Settings at `#engine`; the saved engine stays in use until a key is saved for the previewed engine. Its copy says page titles and a short site hint are sent to the provider.
- **Offline smart mode** selects the local engine.
- When Ollama is the saved engine, **Keep Ollama** leaves it and saves `offline` for a loopback address, otherwise `cloud`. For a non-loopback address its copy says titles and a short site hint are sent to that server.

## Migration from 2.0

Settings load (in the worker on install or update, and in every surface) moves a saved `provider: 'gemini_nano'` to `offline` and `setupChoice: 'nano'` to `offline`, re-reading both just before the write so a choice saved meanwhile wins. It attempts to remove `backgroundPrep` and `cloudEconomyMode` from sync storage and `foldnex_tab_labels_v1` and `foldnex_nano_perf_v1` from local storage; a failed removal is retried on a later load. Any saved engine value that names no engine runs as Offline smart mode (`resolveProvider`), never as a request. Rules, renames, name memory and diagnostics are kept.

## Core workflow

1. Resolve the active Chrome window and its incognito boundary. Private (Incognito) windows send nothing, whatever engine is selected: By task uses Offline smart mode and By site category stays local.
2. Remove duplicate ordinary web pages and allowlisted stateless Chrome pages using a conservative canonical URL.
3. Exclude pinned and browser-internal tabs from grouping.
4. **By site category:** group locally from the address with the service taxonomy and site-name fallback, then apply saved rules and exact renames in a regular window; no model, no request.
5. **By task:** lock explicit user URL rules first (not in incognito), then Socials. Reuse the exact result when the window's semantic fingerprints are unchanged (6 hours).
6. **Offline smart mode:** the local engine plans the remaining tabs (below). No request.
7. **Cloud engine or Ollama:** in a regular window, reuse the plan applied to this unchanged window if there is one, or point to a matching offer or pending request. Otherwise, if at most 10% of the currently unlocked tabs are new or changed since the last model plan for this engine scope, keep its groups and attach those tabs locally (plan upkeep); no request. Otherwise, with at least two unlocked tabs and a free group slot, send one plan request for the window (`planWindowWithCloud`) and wait until the 6-second click budget less 600 ms. An answer in time is validated (`enforcePlan`) and applied. A failed request applies the local engine's result and reports the fallback. A late answer: the local result is applied now, and the answer, if it lands within 30 seconds, is validated, checked against the unchanged window and stored as an offer. A failed or discarded request leaves nothing to reuse, so a later click can send the window again. This step never runs in a private window.
8. Apply exact scoped rename preferences, merge groups with the same name, order groups by their leftmost member, and record privacy-safe diagnostics (not in incognito).

The budget bounds waiting for the model; Chrome API calls and storage can extend total time. A cleanup with fewer than two groupable tabs still removes duplicates but creates no groups. A live-tab read before application excludes tabs that vanished or became pinned.

## Plan request

- Rows: `[ordinal, title, site/path]` for each unlocked groupable tab in strip order (pinned and internal-prefix tabs excluded; other schemes such as `file:` can qualify). Titles have control characters removed, whitespace collapsed and are cut to 160 UTF-16 units (`PROMPT_TITLE_LIMIT`); they are otherwise free text and can contain addresses. For a parseable HTTP(S) address the hint (`compactUrlHint`) is the host without `www.` or port plus up to three path segments, each whole segment that is a long identifier replaced by `:id` before anything is cut, other segments cut to 48 characters, with credentials, query and fragment removed; other schemes give the scheme label. The system prompt states that rows are untrusted data.
- The answer is `{"folders":[{"name","ids"}]}` with at most `10 − locked groups` folders. Gemini receives its response schema, and supported models on OpenAI's official base receive strict Structured Outputs; other compatible paths use JSON object mode. A schema rejection is not retried, and that engine, model and endpoint use JSON mode on later requests in this browser session (hashes in session storage, not in incognito).
- **Anthropic** (`mode: 'anthropic'`) sends `POST https://api.anthropic.com/v1/messages` with `x-api-key`, `anthropic-version: 2026-10-21` and `anthropic-dangerous-direct-browser-access: true` (the request carries the extension's Origin), the plan schema in `output_config.format` (structured output; no assistant prefill, no `temperature`, `top_p` or `top_k`) and one user message. Thinking and effort follow the model (`anthropicModelProfile`, from the Models API capabilities when Settings has listed them, otherwise a table): Opus 5.5 and the Fable and Mythos models cannot turn thinking off and get `output_config.effort: "low"`; Sonnet 5.5 gets `thinking: {type: "between_tools"}`; Haiku 5.5, Sonnet 5, Opus 5 and the other models that support effort and can turn thinking off get `{type: "disabled"}`, each without an effort; `claude-haiku-4-5`, `claude-sonnet-4-5`, any listed model without effort support and an unknown model get neither field, and an unknown model's output budget includes the reasoning headroom. Settings saves the chosen model's capability profile (no key) in `chrome.storage.local` (`anthropicModelProfile`) and `loadSettings` registers it, so the service worker and popup resolve the same profile as Test connection. A 400 about effort or thinking is retried once without both and never turns on JSON mode; only a 400 about the format or schema does. Opus 5, Opus 5.5, Sonnet 5.5 and the Fable and Mythos 5 models also send `fallbacks: "default"` with `anthropic-beta: server-side-fallback-2026-07-01`. `stop_reason` is checked first: `refusal` (the whole fallback chain declined) and `max_tokens` fail the plan; otherwise only text blocks after the last `fallback` block are read, never thinking blocks. A schema rejection follows the JSON-mode rule above. The default model is `claude-opus-5-5`.
- Every request uses the lowest reasoning effort Foldnex lists for the model, or no reasoning control where it lists none (`planReasoningEffort`), whatever is saved, and an output budget of `max(1024, 400 + 12 × tabs)` tokens plus 2,048 when the model reasons, capped at 8,192.
- Validation (`enforcePlan`): it reads at most `rows + 10` folders and `2 × (rows + 10)` ids, whatever the answer holds; the first placement of a tab wins; unknown ids are dropped; a folder named Review Later is no group; the largest folders are kept within the limit and the rest join Review Later; tabs the model left out go to Review Later; names pass `validateGroupName` or take the local name; user renames in memory win. An answer that leaves no usable task folder keeps the local result and says so.
- Test connection in Settings sends the same request for two synthetic tabs with the draft field values, passes only if the validator keeps a folder, and then refreshes the catalog.
- OpenAI **Priority processing** (`openaiPriority`, on unless `false`) sends `service_tier: "priority"`, off sends `"default"`. Ollama cleanups on a loopback address carry `keep_alive` from `modelUnloadAfter` (`immediately` → `0`, `2m`–`60m` as given, `never` → `-1`; `5m` default); the Settings test sends `5m` and catalog requests none.

## Late plan offer

- An offer lives in session storage per window: validated groups (tab IDs, names, colours, keys), the tab-set signature, engine scope, locked partition and the tab-group membership the local result left. The popup is told when it is ready and shows it with **Apply**.
- **Apply** re-checks that the tab set, engine scope, locked partition, membership and reset generation are unchanged, then applies the plan. Otherwise the offer is dropped and the popup says the window changed.
- A cleanup on a window with a valid offer closes duplicates, then changes nothing else and points to the offer; a cleanup while the request is still pending sends nothing new. Closing the window drops its plan, offer and pending request. A late plan never regroups the strip on its own. If Chrome creates only some of the offer's groups, the popup reports the partial result.

## Local engine

- `src/local-engine.js`: average-linkage clustering over idf-weighted title-word overlap plus, when the packaged table has loaded in time, the cosine of static embeddings of the title and up to eight host/path words, weighted 1 and 0.5 (`src/embedder.js`, WordPiece over the int8 potion-base-4M table; words over 40 characters are skipped). One fixed setting for every window. If the vectors put more than half the window in one cluster, title words alone are used for that window.
- The ten largest clusters of two or more tabs, counting locked groups and Review Later, become groups; the rest go to Review Later. Names come from the category or site of most members, then distinctive shared title words, through `validateGroupName`; "Folder" is the last resort.
- It is used for Offline smart mode, for every private-window cleanup and for a failed, late or review-only plan. It makes no request; in the reference test a 200-tab window was embedded and planned in about 20 ms and a whole Offline click took 0.3 to 0.5 s.
- Upkeep and Auto-group attach a tab to the existing group whose members its title words match best on average, at 0.05 or above (title words only); otherwise the tab waits ungrouped or in Review Later.

## Auto-group new tabs

- `autoGroupNewTabs` in sync storage, off by default, By task only, every engine. A tab opened or sent to a new page while it is on joins an existing group in its window when it has a title: a rule's or Socials' tab only the one live group holding that owner's tabs; otherwise the most similar unowned group that is not Review Later. No group is created, grouped tabs are never moved, and no provider request is sent.
- Tab events in the first 20 seconds of a browser session are not treated as new, and tabs created unloaded or discarded are not new. A tab the user takes out of a group, or that **Ungroup current window** ungroups, stays out until it opens a new page. Incognito tabs are never auto-grouped.
- Bookkeeping runs whether or not the setting is on: the worker keeps tab-ID-to-address-hash entries in memory and records taken-out tabs' address hashes in session storage, so a later page change can be recognised.

## Duplicate-survivor contract

- Ignore ordinary document anchors but preserve route-like fragments.
- Keep HTTP and HTTPS identities distinct.
- Retain query keys, values, order, host, port, and path.
- Prefer a pinned survivor, then the active tab, then the leftmost copy. A redundant pinned copy can close when the survivor is still pinned.
- Recheck the survivor once per duplicate set and each candidate immediately before removing it.
- Deduplicate exact URLs for a short allowlist of stateless Chrome pages; preserve other non-HTTP(S) pages.

## Grouping contract

- **By task** groups by active task or purpose, not simply by domain or media type. Foldnex's own By task result budgets at most ten groups (`MAX_GROUPS`), counting locked groups and Review Later. Locked rule and Socials groups are always kept, even past ten, and upkeep keeps existing groups. Tabs that find no slot, or that Chrome refuses, are left ungrouped and the popup reports the count.
- **By site category** uses only the address and makes no model request. Known services use a maintained service taxonomy. X, Reddit, and Slack are Socials; Gmail and Outlook are Email; assistants such as ChatGPT and Grok are AI · Assistants; AI provider consoles and documentation are AI · Platforms. AI groups never merge into Code, Cloud, or generic technology groups. Pages of a recognised base site normally stay together, with path-sensitive services split out. YouTube, Envato, and Tesla are atomic dedicated groups; a multi-service category exceeding 15 tabs splits at service boundaries with names such as Socials · X. Repeated unknown sites use a readable site name; one-off unknowns enter Review Later groups of at most eight tabs. By site category has no ten-group ceiling.
- In either strategy, known social services stay in Socials. Explicit user URL rules take precedence.
- Every current groupable tab is assigned at most once; Review Later starts grey (placement can change a colour to avoid repeating its neighbour) and is never merged into a real group.
- Model and remembered names are validated locally: at most 30 characters and 4 words, not generic or made only of vague words, free of decorative words, not a bare domain, unique, and not contradicted by a member's country-code domain; a rejected name takes the local name. A user's own rename is kept as typed (control characters removed, cut to 30 characters at a word boundary in name memory; the exact rename preference keeps up to 40) unless it is empty, "Review Later" or already used in the window.
- Fresh grouping orders groups by their leftmost original member and keeps strip order within a group; interleaved tabs necessarily move. Upkeep does not reorder existing groups.

## Engine strategy

- Engines (`PROVIDER_CATALOG`): Offline smart mode (`offline`, the default and the fallback for any unknown value), Google Gemini, Anthropic · Claude, OpenAI, xAI Grok, Groq, OpenRouter, DeepSeek, Cerebras, and Ollama.
- One resolver (`resolveProviderEndpoint`) gives the endpoint for catalog, test and cleanup. Cloud engines always use their provider's own address; a saved address override is ignored, and Settings removes it on Save. Ollama defaults to `http://localhost:11434/v1`; a saved Ollama address (read-only in Settings) must use HTTPS unless it is on this device, and must not contain credentials (any `@` in the authority, even empty), a query or a fragment; otherwise it is not used, nothing is sent, the cleanup runs locally and the popup and Settings say the address is not used. Provider requests do not follow redirects (`redirect: 'error'`). Only `localhost`, `127.0.0.1` and `[::1]` count as loopback. Loopback Ollama is the first hop: the request goes to the Ollama server on this device, and that server can itself run cloud models. Ollama at a non-loopback address is treated as cloud in diagnostics and copy, and the popup names its host. The popup and Settings name only the resolver's endpoint. A saved endpoint grants no additional host permission. Anthropic's endpoint is fixed at `https://api.anthropic.com/v1`; an `anthropicBaseUrl` value is never read.
- **Anthropic host permission (D48).** Settings (choosing the engine, Save, Test connection), the popup's engine list and the setup card call `chrome.permissions.request` for `https://api.anthropic.com/*` first in the click or change handler, so it runs on the user's gesture. The engine choice is saved whether or not access is granted. Before any Anthropic request (plan, test or catalog) the engine checks `chrome.permissions.contains`; without the grant nothing is sent, a cleanup applies the local result with fallback class `permission` and the message "access ... is not allowed. Allow it in Settings", the popup shows **Access needed**, and Settings says Chrome did not allow access. Choosing another engine does not revoke the grant.
- Provider model catalogs are fetched live into a dropdown with a Custom model option and kept only in the open Settings page. Settings fetches one when it opens on a remote engine or switches to it, on a committed key, token or address edit, after Save, after a successful current connection test and on **Refresh models**, using the field values even before Save. OpenRouter and Ollama can list without a key. Stale replies cannot replace a newer catalog. The Gemini catalog reads at most 10 pages and stops on a repeated page token; the Anthropic catalog (`GET /v1/models`, paged by `after_id`) has the same bound, lists only `claude-` models and keeps their effort and thinking capabilities for that page's controls. OpenAI Responses-only models are refused before a request.
- Settings still shows a reasoning-effort control where the model offers one; its help text states that cleanups and connection tests send the model's lowest effort. The popup shows the effort a cleanup sends.
- Source defaults (for example OpenAI `gpt-6-luna`, Groq `qwen/qwen3.8-27b`) are not availability or quality guarantees. Only OpenAI's and Anthropic's defaults have been measured on the plan request.

## Data and privacy contract

- API keys and bearer tokens live in `chrome.storage.local`, restricted to trusted extension contexts. The settings loader moves legacy Sync secrets to local storage before removing their Sync copies, preserves existing local values including explicitly empty ones, and serialises migration with secret saves.
- Non-secret preferences may sync through Chrome: engine, strategy, models, the Ollama endpoint, reasoning choices, `openaiPriority`, `setupChoice`, `oneClickIconMode`, `collapseGroupsOnCreation`, `autoGroupNewTabs` and `modelUnloadAfter`. Model IDs and the Ollama endpoint string are stored as entered.
- Requests: only a By task cleanup with a cloud engine or Ollama sends tab data (at most one request; Anthropic alone repeats it once, without the thinking or effort setting, after an HTTP 400 that rejects that setting). A connection test sends synthetic tabs and catalogs send none, both with the typed credential. Manual-rule and Socials tabs are never sent. Private (Incognito) windows send nothing, whatever engine is selected: By task uses Offline smart mode and By site category stays local. Nothing is sent on Offline smart mode, By site category, Auto-group, popup open, tab events or browser start.
- Local storage: URL rules (and a legacy backup), rename preferences (fingerprints, name up to 40 units, colour, time; at most 100, no age limit; learned from any regular-window group rename, including user-made groups), group-name memory (`foldnex_plan_memory_v1`: user renames with tab fingerprints for 90 days; model names and merge advice from earlier versions remain until a write or clear and are not used; at most 120 names), exact results (fingerprints, names, colours, keys; 6 hours, at most 12), a reset generation, run history (20 records plus the last run, including late-plan applications), provider usage totals, and for unpacked installs the latest phase-timing trace. Fingerprints hash a normalised title (up to 1,000 characters) and a sanitised URL with allowlisted query values; no raw title or URL is stored.
- Session storage: window plans (tab IDs, names, colours, keys, tab-set hash over full addresses and titles, and for the last model plan truncated tab fingerprints), plan offers (until checked, replaced, applied, ungrouped, the window closes or the session ends), the JSON-mode list, Auto-group's new-tab IDs and taken-out page hashes (recorded even with Auto-group off), the start-up marker, and group-title baselines and expected-update records.
- Incognito: rules are not read; no exact results, name memory, rename preferences, plans, offers, JSON-mode memory, diagnostics, usage totals or traces are read or written. Shared settings and the reset generation are read and private group titles are kept in worker memory. No request is sent. Renames in incognito teach nothing. Console messages hold no group names. Shared settings can still be changed.
- **Clear all rules** removes rules, the legacy backup, rename preferences, exact results, name memory and any leftover label cache, and bumps the reset generation so stored plans and offers are not reused. **Clear run history** removes the run records. **Clear provider usage** resets the totals; a reply dispatched before the clear cannot restore them.
- Page bodies are never read; there are no content scripts.

## Provider usage

- **Last cleanup** shows engine, the configured model (never the model name a provider returns), source (for example `cloud plan`, `plan upkeep`, `exact cache`, `offline fallback`, `local`), plan request count, reported tokens, latency, quality flags, fallback class and effort. Records from 2.0 with label, naming or consolidation counts still display.
- **Provider request usage** counts each inference request of a cleanup or connection test once it is started, including failed, timed-out and late ones: requests overall and per provider, reported input/output/total, cached-input, cache-write and reasoning tokens (for Anthropic, input counts `input_tokens` plus cache reads and writes), requests without usage, and OpenAI service tiers. Catalog reads and incognito requests are not counted. It holds no titles, URLs, prompts, responses, keys or group names.

## Measured quality

Pairwise F1 against hand-made task groups over every tab, on twelve synthetic evaluation windows (906 tabs, `docs/development/grouping-fix-plan.md` and `eval/results/rescore.md`): a model plan scores 0.88 on Foldnex's Anthropic engine with its default `claude-opus-5-5` at low effort (3.28 s median and 3.58 s p90 over 24 requests, 5.77 s p90 on the windows of 69 to 200 tabs, about 2.2 US cents per window; `eval/results/provider/phase1-engines/report.md`), 0.84 on Claude Sonnet 5.5 (measured directly against the Claude API) and 0.74 to 0.77 on OpenAI's default `gpt-6-luna` through Foldnex's request code, against 0.42 for 2.0-style Claude Haiku 5.5 per-tab labels; the local engine scores 0.39 with the table (0.34 on title words), against 0.19 for the 2.0 local rules. On the ten non-pilot windows the two baselines are 0.40 and 0.18. With 10% new tabs attached by upkeep a Sonnet plan scores 0.79. These are evaluation figures on synthetic windows, not guarantees for a real window or another model.

## Product principles

- One action creates visible order.
- Preserve user context while removing clutter.
- Prefer conservative, recoverable decisions around tabs.
- Keep provider complexity understandable and secondary.
- Make local-versus-cloud behaviour explicit.
- Report concrete outcomes rather than generic success.

## Brand commitments

- Product name: Foldnex.
- Visual language: restrained Magrathean/Teslatlas utility design.
- Use system typography, deep navy or clean neutral surfaces, precise spacing, thin rules, and compact actions.
- Avoid generic AI gradients, sparkles, emoji decoration, promotional model artwork, and card-grid settings.

## Acceptance criteria

These are checks for a behaviour change, not a record that the current build passed them.

- Duplicate removal preserves the correct survivor and reports the count.
- Every surviving groupable tab is placed at most once and Foldnex's own By task result never exceeds ten groups apart from locked rule and Socials groups, whatever the model returns.
- A cloud or Ollama cleanup sends at most one request per window (Anthropic alone repeats it once after an HTTP 400 that rejects its thinking or effort setting; the per-run panel counts plans, usage totals count HTTP requests); a repeat click on an unchanged window after an applied plan and an upkeep click send none; manual-rule and Socials tabs are never in the request.
- A late plan is offered and applied only by **Apply** on an unchanged window.
- A private window sends nothing on any engine and gets the Offline smart mode result.
- A provider failure applies the local result and says so.
- Offline smart mode, By site category, Auto-group and the background send nothing.
- Auto-group places only tabs opened or sent to a new page while it is on, only into existing groups, and never moves a grouped tab or one the user took out.
- A saved Gemini Nano engine becomes Offline smart mode with no request, and the removed keys are gone after a successful settings load.
- The setup card shows until a choice is saved, never blocks a cleanup, and a Cloud choice without a key leaves the saved engine active.
- Diagnostics identify engine, source, tokens, latency, groups, duplicates, fallback class and quality flags without tab content; a reply begun before a clear cannot restore cleared totals or memory.
- API keys stay out of sync storage, exported rules, logs and source control.
- The popup and settings remain usable with keyboard focus, reduced motion, and narrow widths.
- Current browser behaviour is checked separately from syntax and mocked-provider tests.

## Maintained evidence

- Behaviour: `background.js`, `src/grouper.js`, `src/planner.js`, `src/local-engine.js`, `src/embedder.js`, `src/label-vocabulary.js`, `src/ai-engine.js`, `src/background-classifier.js`, `src/cache-engine.js`, `src/settings.js`, `src/provider-usage.js`, `src/group-state.js`, `src/debug-trace.js`, and `src/site-clusterer.js`.
- User surfaces: `popup.*` and `options/*`.
- Permissions and entry points: `manifest.json`.
- Product-facing setup and privacy guidance: `README.md`, `docs/user-guide.md`, `docs/legal/privacy.md`.
- Visual authority: `docs/architecture/design.md`, `popup.css`, and `options/options.css`. The older generated `.impeccable/design.json` describes a superseded palette and must not override these files.
