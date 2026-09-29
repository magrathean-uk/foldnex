<h1 align="center">Foldnex</h1>

<p align="center">A free, MIT-licensed Chrome extension that removes duplicate tabs and organises the rest into tab groups.</p>

<p align="center">
  <a href="https://magrathean.uk/apps/foldnex/">Website</a> ·
  <a href="docs/index.md">Documentation</a> ·
  <a href="https://magrathean.uk/apps/foldnex/privacy/">Privacy</a>
</p>

## Overview

Foldnex is a Manifest V3 Chrome extension that removes conservative exact duplicate tabs and organises the remaining tabs in the current window into Chrome tab groups. It can classify by task with a selected local or optional cloud engine, or classify locally by site category.

## What's new in 2.0

- **Label, then plan.** In By task mode the engine only gives each tab one of 23 fixed categories. Foldnex builds the groups itself, deterministically, with at most 10 groups and no minimum.
- **A one-time setup choice.** The popup asks once how Foldnex should sort your tabs: **Cloud AI** with your own API key, **Gemini Nano** on this device, or **Offline** with no AI. New installs and updates to 2.0 both see it. It never blocks a cleanup, and you can change the engine later in Settings.
- **Labels ahead of time, if you want them.** With **Prepare groups in the background** on, Chrome Gemini Nano and local Ollama label tabs on your device as they load, so a cleanup of an already-labelled window applies cached labels. It is off until you turn it on, choose Gemini Nano in the setup card, or turn on Auto-group. In one test, 118 tabs became 10 groups in 0.45 seconds on Gemini Nano; the first background pass over 106 tabs took about 55 seconds, including a cold model load of about 20 seconds.
- **Model memory you control.** While Gemini Nano is loaded, Chrome uses about 3 GB of memory. Foldnex releases its model sessions after 5 minutes idle by default; Settings offers right after use, 2, 15 or 60 minutes, or keep loaded, plus **Free memory now**. Chrome then frees the memory itself, about 5 minutes after the last use in our measurement. Loading it again takes 15-25 seconds. Ollama on this device gets the same setting as its `keep_alive` (Ollama 0.35 or later).
- **A bounded cleanup.** A cleanup has a budget of about 4.5 seconds, and model work stops in time to regroup the strip within it. Tabs without a label by then are placed by address and sorted later; with an on-device engine that happens right after the cleanup, even with background preparation off. A window whose tabs are all labelled already waits at most 1.2 seconds for group names, and a later answer is remembered for the next cleanup.
- **Memory.** Per-tab labels are kept for seven days and group names for up to 90 days, without storing titles or URLs. Your own renames are kept as typed; model names are checked locally, and vague or decorative names are rejected.
- **Auto-group new tabs** (optional) files tabs you open into matching groups as they load.
- **OpenAI** defaults to `gpt-6-luna` at Low reasoning effort with **Priority processing** on. In our test it labelled and named 100 tabs on a cold cleanup in 2.6 seconds, and a repeat cleanup took about 5 ms; with Priority off, a cold cleanup reached the 4.5-second budget with half the tabs placed by address.
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

**By task** groups tabs by purpose into at most 10 groups, and fewer for smaller or less varied windows (for example at most 4 for 8-12 tabs); only when explicit URL rules and Socials already fill that limit can one more group form. The selected engine only gives each tab one category label from a fixed list; Foldnex then plans the groups locally, keeps every tab exactly once, and can split out a shared task such as a trip that spans several sites. Group names come from your earlier renames, then remembered names, then an optional naming or consolidation request when time allows; model and remembered names are checked locally and a rejected one keeps its deterministic name, such as the category name, while your own renames are kept as typed (up to 30 characters). A cleanup takes about 5 seconds at most. Tabs the engine has not labelled by then are placed by address; an on-device engine labels them in the background right after the cleanup, even with background preparation and Auto-group off, and a cloud engine's late answers are kept for the next cleanup. When every tab's label is already cached, a cleanup waits at most 1.2 seconds for a naming or consolidation answer; a later one is remembered for the next cleanup. Page titles are capped at 160 characters in prompts, while URL context is reduced to host and path hints.

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
| Ollama | User's local server at `http://localhost:11434` | Optional |

Cloud model catalogs are discovered from the configured provider and cached locally for six hours. A model ID may be entered manually. Reasoning controls are shown only where the selected provider and model support them; unsupported request parameters are omitted.

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

The popup reports groups created, duplicates removed, tabs placed provisionally, and offline fallback use. Settings keeps privacy-safe run diagnostics such as engine, source, group count, group names and sizes, token count when reported, latency, and quality flags.

## Configure providers and rules

Open **Rules and settings** from the popup or the extension Options action. Select an engine, enter a provider credential when needed, select or type a model, choose reasoning effort when offered, and save. **Test connection** sends two synthetic tabs and does not send the current window. OpenAI defaults to `gpt-6-luna` at Low effort; its **Priority processing** setting, on by default, requests faster responses at OpenAI's higher per-token price. Turning it off saves that premium, but a cold cleanup then places more tabs by address. OpenAI models that support Structured Outputs on the default base URL get a strict JSON schema, and Google Gemini gets a response schema; other OpenAI models and the other OpenAI-compatible providers use JSON mode, and Foldnex validates every answer locally.

API keys and bearer tokens are stored in `chrome.storage.local`. Non-secret preferences, including the setup choice, background preparation, and the model unload setting, may use `chrome.storage.sync`. Explicit URL rules can be searched, added, exported, imported, deleted, or cleared. Imported rule files are schema-validated and limited to 1 MB. **Clear all rules** also clears the exact-result cache, per-tab labels, group-name memory, and rename preferences; **Clear run history** clears diagnostics.

## Chrome Gemini Nano

Chrome's Prompt API depends on Chrome, device, policy, storage, and model-download eligibility. Foldnex checks the API at runtime and runs Nano in its service worker, so the popup, toolbar, and keyboard shortcut all use it. Because a cold model load takes 15-25 seconds, Foldnex warms Nano when you open the popup, once the setup card has been answered and unless the unload setting is **Right after use**. It also warms Nano when Chrome starts, but only while background preparation or Auto-group is on. A cleanup that finds the model still loading places tabs by address and says so. Runs fall back to local placement if the Prompt API is unavailable. Chrome's own diagnostic page is `chrome://on-device-internals`.

**Background preparation.** The engine settings for Gemini Nano, and for Ollama on this device, include **Background work and memory**. **Prepare groups in the background** is off until you turn it on or choose Gemini Nano in the setup card, and **Auto-group new tabs** keeps it on. While it is on and Nano is selected for By task, Foldnex labels every open tab in every non-incognito window when you turn it on, after Chrome starts, and after Foldnex is installed or updated. After that it labels each tab as it loads, and opening the popup moves the current window's tabs to the front of the queue. Local Ollama behaves the same way. With it off, tabs are labelled when you clean up, which takes a few seconds instead of under one; tabs that cleanup placed by address are labelled on your device right after it, and then background work stops. Turning it off while Auto-group is also off stops any background work still queued.

**Model memory.** While Gemini Nano is loaded, Chrome uses about 3 GB of memory. Foldnex keeps its hold on the model only while you use it. **Unload the on-device model** releases Foldnex's model sessions after 5 minutes idle by default; you can also choose right after use, 2, 15 or 60 minutes, or **Keep loaded**. The idle unload never interrupts a cleanup or background batch. **Free memory now** lets go at once, and so does switching to another engine. Once Foldnex lets go, Chrome frees the memory itself; in testing that took about 5 minutes after the last use. Saved labels are kept, so only unlabelled tabs need the model loaded again. **Keep loaded** lasts only while Chrome keeps Foldnex's service worker running. Requests to Ollama on this device send the saved unload setting as `keep_alive`. Ollama 0.35 and later apply it on the endpoint Foldnex uses; older versions ignore it and keep their own default.

## Privacy boundaries

Foldnex does not use content scripts and does not read page bodies, cookies, keystrokes, or form submissions. For By task cloud grouping, the selected provider receives tab titles (up to 160 characters each) and sanitised host/path hints from the current window. URL credentials, query strings, and fragments are removed before prompting. Provider credentials are sent separately for authentication. Titles and paths can still contain sensitive information. With a cloud engine and **Auto-group new tabs** on, the title and host/path hint of each tab you open or send to a new page afterwards are also sent in the background; tabs that were already open are sent only when you run a cleanup. By site category, Offline smart mode, a working Chrome on-device model, and Ollama on a loopback address do not send tab data to a cloud provider. Background preparation applies only to on-device engines and never sends tab data to a cloud provider. The setup card's **Cloud AI** choice only checks whether a key is saved; that check never displays, syncs, or sends the key.

Foldnex keeps per-tab category labels (up to 3,000, for seven days) and group-name memory (your renames for 90 days, model names for 14 days) in `chrome.storage.local`. Both are keyed by fingerprints and hashes rather than titles or URLs, although group names themselves can reflect what the tabs are about. Each window's latest plan (tab IDs and group names) lives in session storage and is cleared when Chrome closes. Unpacked development installs also keep the latest phase-timing trace; store installs never record one.

Incognito tabs are never labelled in the background or auto-grouped, and incognito grouping runs do not persist rules, cache, labels, name memory, diagnostics, or rename preferences. A cloud engine still receives that window's title and URL hints when selected. User changes to settings can still be saved.

Read [privacy](docs/legal/privacy.md) for the full data contract and [terms](docs/legal/terms.md) for the usage terms.

## Development and verification

From the repository root:

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

- [Documentation index](docs/index.md)
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
