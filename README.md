<h1 align="center">Foldnex</h1>

<p align="center">A free, MIT-licensed Chrome extension that removes duplicate tabs and organises the rest into tab groups.</p>

<p align="center">
  <a href="https://magrathean.uk/apps/foldnex/">Website</a> ·
  <a href="docs/index.md">Documentation</a> ·
  <a href="https://magrathean.uk/apps/foldnex/privacy/">Privacy</a>
</p>

## Overview

Foldnex is a Manifest V3 Chrome extension that removes conservative exact duplicate tabs and organises the remaining tabs in the current window into Chrome tab groups. It can classify by task with a selected local or optional cloud engine, or classify locally by site category.

Start with the [user guide](docs/user-guide.md) for setup, engine choices, rules, memory controls, and troubleshooting. The [changelog](CHANGELOG.md) records the changes in 2.0. The extension is free; optional cloud providers may charge for API use.

## What's new in 2.0

- **Label, then plan.** In By task mode the engine only gives each tab one of 23 fixed categories. Foldnex builds the groups itself, deterministically, normally targeting at most 10 groups with no minimum; protected rules, Socials and remembered user names can exceed that ceiling.
- **A one-time setup choice.** The popup asks once how Foldnex should sort your tabs: **Cloud AI** with your own API key, **Gemini Nano** on this device, or **Offline** with no AI. New installs and updates to 2.0 both see it. It never blocks a cleanup, and you can change the engine later in Settings.
- **Labels ahead of time, if you want them.** With **Prepare groups in the background** on, Chrome Gemini Nano and local Ollama label open tabs across non-incognito windows on your device, then label tabs as they load. It is off until you turn it on, choose Gemini Nano in the setup card, or turn on Auto-group. Prepared labels can make a later cleanup faster; timing depends on your device, selected model, and window.
- **Model memory you control.** Foldnex releases its Gemini Nano sessions after 5 minutes idle by default; Settings offers right after use, 2, 15 or 60 minutes, or keep loaded, plus **Free memory now**. Chrome controls when the model's memory is freed. An earlier Apple Silicon Mac test measured about 3 GB while loaded and a 15–25 second cold load; these are observations, not device requirements or performance guarantees. Local Ollama receives the same setting as `keep_alive`.
- **A bounded cleanup.** A cleanup gives model work about 4.5 seconds before applying groups. Tabs without a label by then are placed by address; an on-device engine labels them in the background for a later cleanup, even with background preparation off. Ordinary cloud requests can finish after that deadline, with their labels saved for the next cleanup. A window whose tabs are all labelled already waits at most 1.2 seconds for group names, and a later answer is remembered for the next cleanup.
- **Memory.** Per-tab labels are eligible for reuse for seven days. Plan memory reuses user names for up to 90 days and model names for 14 days; exact-cohort rename preferences are separately capped at 100 records without an age expiry. These records use hashes rather than raw titles or URLs. Names themselves can contain sensitive text; model names are checked locally.
- **Auto-group new tabs** (optional) files tabs you open into matching groups as they load.
- **OpenAI** defaults to `gpt-6-luna` at Low reasoning effort with **Priority processing** on. Priority requests can cost more; turn it off in Settings to request the default service tier. Model availability, latency, and billing are controlled by the provider.
- **Cloud economy mode** is an optional setting, off by default. It skips optional cloud group refinement and naming while retaining category labels and local planning; remembered or deterministic names may be simpler. Concurrent cleanups can share matching cloud label and refinement requests that are already running. Saved model labels, names and merge advice are scoped to the engine, model, effective reasoning effort and endpoint; switching settings reassesses tabs, while returning to an earlier configuration can reuse its saved work. Your own renames remain available across engines.
- **Provider request usage** keeps local, content-free totals for inference and connection tests, including late and background replies, separately from the last-cleanup report.
- Gemini Nano now runs in the service worker, so the popup, toolbar, and keyboard shortcut all use it. Offline smart mode uses the same local planner with labels inferred from each tab's address and title.

## What it does

- Removes duplicate ordinary web pages while preferring a pinned tab, then the active tab, then the leftmost copy. A redundant pinned copy can close when the survivor remains pinned.
- Ignores ordinary document fragments when identifying duplicates, but keeps route-like fragments and keeps HTTP and HTTPS distinct.
- A short allowlist of stateless Chrome pages, including extensions, downloads, history, and bookmarks, may also be deduplicated by exact URL.
- Leaves pinned tabs and browser-internal, extension, and developer-tool pages outside grouping.
- Offers **By task**, which uses page titles and sanitised URL context, and **By site category**, a deterministic local taxonomy.
- Falls back to local placement by site and title words when a selected model is unavailable.
- Applies explicit URL rules and exact-cohort rename preferences before creating groups.
- Supports popup, toolbar, and keyboard-command workflows for the current Chrome window.
- Remembers each tab's category label and your group names, can label open and newly loaded tabs in the background with an on-device engine when you turn on background preparation, and can file tabs you open into matching groups automatically (**Auto-group new tabs**).

Each cleanup operates on one window at a time and keeps incognito processing within the matching incognito boundary. Background labelling and Auto-group follow tabs in every non-incognito window.

## Grouping choices

**By task** groups tabs by purpose, normally targeting at most 10 groups. Smaller windows have a preferred compactness target, but distinct topics can remain separate above that target; Shopping, Maps, or News are not forced into Coding just because each has one tab. Explicit URL rules, Socials and remembered user names remain protected and can exceed the ordinary ceiling; when locked groups already fill the limit, the remaining tabs can form one extra group. The selected engine only gives each tab one category label from a fixed list; Foldnex then plans the groups locally, keeps every tab exactly once, and can split out a shared task such as a trip that spans several sites. Unplaced tabs stay in Review Later, even when only one remains. Related categories can combine under names that describe both subjects. Group names come from your earlier renames, then remembered names, then an optional naming or consolidation request when time allows; model and remembered names are checked locally and a rejected one keeps its deterministic name, such as the category name, while your own renames are kept as typed (up to 30 characters). Cloud economy mode skips the optional cloud request and uses the remembered or deterministic names. The model budget is about 4.5 seconds, followed by Chrome's grouping work. Tabs the engine has not labelled by then are placed by address; an on-device engine labels them in the background for a later cleanup, even with background preparation and Auto-group off, and a cloud engine's late answers are kept for the next cleanup. When every tab's label is already cached, a cleanup waits at most 1.2 seconds for a naming or consolidation answer; a later one is remembered for the next cleanup. Page titles are capped at 160 characters in prompts, while URL context is reduced to host and path hints.

**By site category** uses the address only and makes no model request. The taxonomy covers common services such as Socials, Email, AI, Code, media, work, commerce, and personal administration. Recognised services can split into service-specific groups when a category becomes crowded. Explicit user rules still take precedence.

## Engines

The popup and settings page expose one engine list:

| Engine | Processing | Credentials |
| --- | --- | --- |
| Chrome Gemini Nano | Chrome on-device Prompt API when available | None |
| Offline smart mode | Local title, URL, keyword, and domain heuristics | None |
| Google Gemini | Google Gemini API | User API key |
| OpenAI | OpenAI-compatible chat completions | User API key or bearer token |
| xAI · Grok | xAI API | User API key |
| Groq | Groq OpenAI-compatible API | User API key |
| OpenRouter | OpenRouter routing API | User API key where required |
| DeepSeek | DeepSeek OpenAI-compatible API | User API key |
| Cerebras | Cerebras API | User API key |
| Ollama | Configured server; `http://localhost:11434` by default | Optional |

Cloud model catalogs are fetched from the configured provider and shown in a full dropdown, with a **Custom model** option for entering a model ID manually. Entering or changing a credential refreshes the catalog, as does a successful connection test. Catalogs are kept only in the open settings page, so an earlier account's saved list cannot hide available models. Reasoning controls are shown only where the selected provider and model support them; unsupported request parameters are omitted.

The runtime honours a saved compatible-provider base URL, including an Ollama address. Loopback Ollama runs on this device; a remote Ollama address is treated as a cloud engine. Changing an endpoint does not grant access to a new host: requests remain subject to the hosts in `manifest.json` and Chrome's network rules. The packaged host permissions cover the listed HTTPS providers and `http://localhost:11434/*`.

## Install from source

Foldnex has no transpilation step and no runtime package dependencies.

1. Download or clone the repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the directory containing `manifest.json`.
5. After source changes, use **Reload** on the Foldnex extension card.

The manifest declares Chrome 120 as the minimum Chrome version. Store listing and submission material is maintained separately in [Chrome Web Store preparation](docs/development/chromewebstore.md). A store listing or its availability is not implied by this source installation path.

## Use Foldnex

- The first time you open the popup, including once after updating to 2.0, a setup card asks how Foldnex should sort your tabs: **Cloud AI**, **On this device — Gemini Nano**, or **Offline — no AI**, or **Keep Ollama** when Ollama is already your engine. **Cloud AI** uses an engine you already saved a key for, or opens Settings so you can add one; your current engine stays in use until you save it. **Gemini Nano** also turns on background preparation, and opens Settings when Chrome still needs to download the model. The card never blocks a cleanup. With **Run from toolbar** on, the toolbar icon keeps opening the popup until the card is answered.
- Open the popup and choose **Clean up and group**.
- Choose **By task** or **By site category**.
- Use `Alt+G` on Windows and Linux, or `Command+Shift+G` on macOS, to group the current window.
- Use `Alt+U` on Windows and Linux, or `Command+Shift+U` on macOS, to ungroup the current window.
- In Behaviour settings, enable direct toolbar execution, **Auto-group new tabs**, or collapsed groups when needed. Auto-group needs Chrome Gemini Nano, Ollama, or a cloud engine with By task. With an on-device engine it also keeps background preparation on, because it needs labels.

**Ungroup current window** removes groups; it does not restore duplicate tabs that were closed.

The popup reports groups created, duplicates removed, tabs placed provisionally, and offline fallback use. A saved cloud credential is shown as configured, with explicit guidance after a matching cleanup fails; it does not imply a verified connection. Nano availability means Chrome has downloaded the model; the memory controls separately report whether Foldnex has loaded it. Settings keeps privacy-safe run diagnostics such as engine, source, group count, group names and sizes, token count when reported, latency, and quality flags. Task-mode diagnostics show the preferred group target; distinct topics may exceed it up to ten groups. Failed dispatched batches count as model calls, while preflight failures and recipients sharing another cleanup's result add no new request. The provider-usage totals count HTTP inference requests, including compatibility retries, separately from these logical cleanup batches.

## Configure providers and rules

Open **Rules and settings** from the popup or the extension Options action. Select an engine, enter a provider credential when needed, select a model from the full catalog or choose **Custom model**, choose reasoning effort when offered, and save. **Test connection**, beside the API-key field, sends two synthetic tabs and does not send the current window. A successful test refreshes the model catalog without changing your selected model. OpenAI defaults to `gpt-6-luna` at Low effort; its **Priority processing** setting, on by default, sends `service_tier: "priority"`. Turning it off sends `service_tier: "default"`, including in the connection test. The provider determines the returned tier and billing. OpenAI models that support Structured Outputs on the default base URL get a strict JSON schema, and Google Gemini gets a response schema; other OpenAI models and the other OpenAI-compatible providers use JSON mode, and Foldnex validates every answer locally. Gemini requests include an output-token cap that scales with request size and reasoning effort, including hidden reasoning in that budget.

**Cloud economy mode** is off by default and applies to cloud engines, including remote Ollama. Turn it on to skip optional cloud naming and consolidation requests. Category labelling and local planning continue, using remembered or deterministic names. It does not enable cloud background work. Matching non-incognito label requests share active work under the same provider settings, and identical consolidation requests do the same. That sharing lasts only while the request is running; its keys and tab inputs stay in worker memory.

API keys and bearer tokens are stored in `chrome.storage.local`, restricted to trusted extension contexts. The shared settings loader automatically migrates legacy Sync credentials: it preserves current or explicitly empty local values, writes missing local credentials before removing their Sync copies, and serializes migration with new credential saves. Non-secret preferences, including the setup choice, background preparation, cloud economy mode and the model unload setting, may use `chrome.storage.sync`. Explicit URL rules can be searched, added, exported, imported, deleted, or cleared. Patterns are case-insensitive, use `*` as their only wildcard, and are limited to 200 characters; other punctuation is literal. Imported rule files are schema-validated and limited to 1 MB. **Clear all rules** also clears the exact-result cache, per-tab labels, group-name memory and rename preferences, and invalidates session plans. A generation guard prevents work started before clearing from restoring usable old memory. Credentials, preferences, cleanup history and provider usage have separate storage and reset controls.

**Clear run history** clears cleanup diagnostics. **Clear provider usage** separately resets the local provider-inference totals: request counts, provider counts, reported input/output/total and reasoning tokens, input-cache reads/writes, missing-usage counts and returned OpenAI service-tier counts. Late and background inference replies and connection tests contribute to these totals; model-catalog reads do not. These aggregates contain no tab titles, URLs, prompts, responses or credentials, and an outstanding reply from before a clear cannot restore the old totals. The totals are reported usage, rather than a price calculation.

## Chrome Gemini Nano

Chrome's Prompt API depends on Chrome, device, policy, storage, and model-download eligibility. Foldnex checks the API at runtime and runs Nano in its service worker, so the popup, toolbar, and keyboard shortcut all use it. A cold load can take several seconds, so Foldnex warms Nano when you open the popup, once the setup card has been answered and unless the unload setting is **Right after use**. It also warms Nano when Chrome starts, but only while background preparation or Auto-group is on. A cleanup gives an unfinished load a bounded wait of up to 1.5 seconds, then places unlabelled tabs locally and reports that they are provisional. Runs fall back to local placement if the Prompt API is unavailable. Chrome's own diagnostic page is `chrome://on-device-internals`.

**Background preparation.** The engine settings for Gemini Nano, and for Ollama on this device, include **Background work and memory**. **Prepare groups in the background** is off until you turn it on or choose Gemini Nano in the setup card, and **Auto-group new tabs** keeps preparation active even if its separate switch is off. With By task and an on-device engine, allowed background work labels open tabs across non-incognito windows when enabled, after Chrome starts, and after Foldnex is installed or updated. After that it labels tabs as they load, and opening the popup prioritises the current window. With both background settings off, a cleanup still labels tabs it placed provisionally on your device for a later cleanup, then stops. Turning preparation off while Auto-group is also off stops ordinary queued background work.

**Model memory.** Gemini Nano can use several GB of memory; an earlier Apple Silicon Mac measurement observed about 3 GB. **Unload the on-device model** releases Foldnex's sessions after 5 minutes idle by default; you can also choose right after use, 2, 15 or 60 minutes, or **Keep loaded**. Right after use has a brief grace period, and idle unload waits for active model work. **Free memory now** releases Foldnex's base sessions; a prompt already running can finish on its own clone. Switching engines also releases the hold. Chrome determines when memory is freed. Saved labels remain available. **Keep loaded** lasts only while Chrome keeps Foldnex's service worker running. Local Ollama receives the saved unload setting as `keep_alive`; support depends on the installed Ollama version. The Nano memory-state display and manual release control do not inspect or unload Ollama.

## Privacy boundaries

Foldnex does not use content scripts and does not read page bodies, cookies, keystrokes, or form submissions. For By task cloud grouping, the selected provider receives tab titles (up to 160 characters each) and sanitised host/path hints from the current window. URL credentials, query strings, and fragments are removed before prompting. Provider credentials are sent separately for authentication. Titles and paths can still contain sensitive information. With a cloud engine and **Auto-group new tabs** on, the title and host/path hint of each tab you open or send to a new page afterwards are also sent in the background; tabs that were already open are sent only when you run a cleanup. By site category, Offline smart mode, a working Chrome on-device model, and Ollama on a loopback address do not send tab data to a cloud provider. Background preparation applies only to on-device engines and never sends tab data to a cloud provider. The setup card's **Cloud AI** choice only checks whether a key is saved; that check never displays, syncs, or sends the key.

Foldnex stores per-tab category labels (up to 3,000, eligible for seven days) and plan memory (user names eligible for 90 days, model names for 14 days) in `chrome.storage.local`. Expired cache/name records can remain until a subsequent write removes them. Separate exact-cohort rename preferences retain up to 100 records without an age expiry. These records use fingerprints and hashes rather than raw titles or URLs, although group names themselves can reflect what the tabs are about. Window plans, Auto-group eligibility and group-title bookkeeping live in session storage until Chrome closes or the extension reloads. Unpacked development installs also keep the latest phase-timing trace; store installs never record one.

Incognito tabs are never labelled in the background or auto-grouped, and incognito grouping runs do not persist rules, cache, labels, name memory, diagnostics, provider-usage totals, session group-title baselines or rename preferences. Incognito inference requests do not share ordinary-window in-flight work. A cloud engine still receives that window's title and URL hints when selected. User changes to settings can still be saved.

Read [privacy](docs/legal/privacy.md) for the full data contract and [terms](docs/legal/terms.md) for the usage terms.

## Development and verification

From the repository root, follow the [Clean Development workflow](.github/CONTRIBUTING.md#development) in the contributor guide. Run commands that write caches or output through `clean-development run --session session-only --` on this managed machine:

```sh
npm test
for file in background.js popup.js options/options.js src/*.js; do
  node --check "$file"
done
git diff --check
```

To create the source-defined Chrome Web Store archive and checksum:

```sh
npm run package:store
```

The package script validates its listed files, writes `dist/foldnex-<version>.zip`, tests the archive, and writes its SHA-256 file. It does not package documentation or store artwork. Browser behaviour still needs checking by loading the unpacked extension in Chrome, especially popup, settings, shortcuts, duplicate handling, and grouping.

## Repository map

```text
manifest.json          Manifest, permissions, hosts, options, and commands
background.js           Service worker, commands, badges, and run orchestration
popup.*                 Popup cleanup and engine-selection surface
options/*               Provider, rules, diagnostics, and behaviour settings
src/grouper.js          Deduplication, click budget, and Chrome tab-group orchestration
src/planner.js          Local group planning, ceiling, and name validation
src/label-vocabulary.js Fixed category vocabulary and title lexicon
src/ai-engine.js        Provider catalog, model discovery, and label requests
src/settings.js         Shared settings reads and local credential migration
src/provider-usage.js  Content-free provider inference request totals
src/background-classifier.js Background labelling, plan refresh, and auto-grouping
src/site-clusterer.js   Deterministic site-category grouping
src/cache-engine.js     Sanitisation, rules, label cache, name memory, and preferences
src/group-state.js      Programmatic group-update suppression
src/debug-trace.js      Phase timings for unpacked development installs
docs/architecture/product.md  Behavioural product contract
docs/architecture/design.md   Maintained visual-system reference
docs/development/chromewebstore.md  Store metadata and reviewer material
```

## Documentation

- [User guide](docs/user-guide.md), [changelog](CHANGELOG.md), and [documentation index](docs/index.md)
- [Contributing and validation](.github/CONTRIBUTING.md)
- [Support](.github/SUPPORT.md) and [security reporting](.github/SECURITY.md)
- [Product contract](docs/architecture/product.md) and [design system](docs/architecture/design.md)
- [Agent guidance](AGENTS.md)

## Licence

Foldnex's source code is open source under the [MIT licence](LICENSE). Using the published
extension is covered by our [terms of service](docs/legal/terms.md); see
[licensing](docs/legal/licensing.md) for how the two fit together. The bundled Material
Symbols font keeps its own [Apache-2.0 notice](docs/legal/third-party-notices.md).

<sub>© 2026 MAGRATHEAN UK LTD · <a href="https://github.com/magrathean-uk/.github/blob/main/LEGAL.md">Legal</a></sub>
