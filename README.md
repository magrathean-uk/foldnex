<h1 align="center">Foldnex</h1>

<p align="center">A free, MIT-licensed Chrome extension that removes duplicate tabs and organises the rest into tab groups.</p>

<p align="center">
  <a href="https://magrathean.uk/solutions/foldnex/">Website</a> ·
  <a href="docs/index.md">Documentation</a> ·
  <a href="https://magrathean.uk/solutions/foldnex/privacy/">Privacy</a>
</p>

## Overview

Foldnex is a Manifest V3 Chrome extension that removes conservative exact duplicate tabs and organises the remaining tabs in the current window into Chrome tab groups. By task, it groups with a local engine on your device or, if you choose, with at most one request per cleanup to a cloud model or Ollama (Anthropic: a second, identical request without the thinking or effort setting if Anthropic rejects it with HTTP 400); By site category groups locally by address.

Start with the [user guide](docs/user-guide.md) for setup, engine choices, rules, memory controls, and troubleshooting. The [changelog](CHANGELOG.md) records what changed in 2.2 and 2.1. The extension is free; optional cloud providers may charge for API use.

## What's new in 2.2

- **Anthropic · Claude engine.** Plans a window in one request to Anthropic's Messages API (`https://api.anthropic.com/v1`, fixed), like the other cloud engines. The default model is `claude-opus-5-5` at low effort; the model list comes from Anthropic's Models API.
- **Optional host access.** `api.anthropic.com` is an optional host permission, not an install-time one: Chrome asks for it when you choose or save Anthropic, or run its Test connection, in Settings, in the popup's engine list or in the setup card. Until it is allowed, cleanups with Anthropic run locally, send nothing and say so.

On the twelve evaluation windows the shipped request scored 0.88 (all tabs) in 3.28 s median and 3.58 s p90 over 24 requests (windows of 69 to 200 tabs had a p90 of 5.77 s) for about 2.2 US cents per window ([results](eval/results/provider/phase1-engines/report.md)).

## What's new in 2.1

- **At most one request per window.** With a cloud engine or Ollama, a cleanup sends at most one request for the window and the model returns named groups. The one exception is Anthropic: if it rejects the thinking or effort setting with HTTP 400, Foldnex repeats the same request once without that setting. Foldnex checks and repairs the answer locally and applies it. The 2.0 per-tab labels, their batches, naming and consolidation requests are gone.
- **A local engine for everything else.** Offline smart mode and a failed or late request use a local engine that clusters tab titles and address words with a small word table built into the extension (potion-base-4M, MIT). It sends nothing.
- **Fewer requests.** A regular window whose applied plan is still current is not sent again, and when at most 10% of its tabs are new or changed since the model's last plan, Foldnex adds them on the device instead of asking again. A failed or discarded request can be sent again on the next click.
- **Late answers are offered, not applied.** Foldnex waits about 5.4 seconds. A later answer that still matches the window appears in the popup with **Apply**; the strip never changes on its own.
- **Auto-group is local on every engine.** In By task, new tabs join an existing matching group on the device; nothing is sent.
- **Private windows send nothing.** Private (Incognito) windows send nothing, whatever engine is selected: By task uses Offline smart mode and By site category stays local.
- **Gemini Nano is removed.** A saved Nano choice becomes Offline smart mode. Background preparation, the Nano memory controls and Cloud economy mode are removed with it.

On twelve synthetic evaluation windows (906 tabs, pairwise F1 over all tabs against hand-made task groups), a Claude Sonnet 5.5 plan measured directly against the Claude API scored 0.84 and OpenAI's default model 0.74 to 0.77, against 0.42 for 2.0-style per-tab labels; the local engine scored 0.39, against 0.19 for 2.0's local rules ([evaluation record](docs/development/grouping-fix-plan.md)). Anthropic's default model was measured the same way in 2.2.0 (above); the other engines' defaults were not.

## What it does

- Removes duplicate ordinary web pages while preferring a pinned tab, then the active tab, then the leftmost copy. A redundant pinned copy can close when the survivor remains pinned.
- Ignores ordinary document fragments when identifying duplicates, but keeps route-like fragments and keeps HTTP and HTTPS distinct.
- A short allowlist of stateless Chrome pages, including extensions, downloads, history, and bookmarks, may also be deduplicated by exact URL.
- Leaves pinned tabs and browser-internal, extension, and developer-tool pages outside grouping.
- Offers **By task**, which uses page titles and short site hints, and **By site category**, a deterministic local taxonomy.
- Applies explicit URL rules and Socials first and does not send their tabs to a model. Private windows do not read saved rules.
- Remembers your group renames and reuses the result for an unchanged window.
- Supports popup, toolbar, and keyboard-command workflows for the current Chrome window, and optionally files new tabs into matching groups (**Auto-group new tabs**).

Each cleanup operates on one window at a time. Private (Incognito) windows send nothing, whatever engine is selected: By task uses Offline smart mode and By site category stays local.

## Grouping choices

**By task** groups tabs by purpose. Foldnex's own result uses at most ten groups, counting rule, Socials and Review Later groups; rule and Socials groups are always kept, and when slots run out some tabs stay ungrouped. With a cloud engine or Ollama the model plans the window in one request; with Offline smart mode, or when no usable model answer is available in time, the local engine does. Tabs that fit no group go to **Review Later**. Model names are checked locally and a rejected one takes a local name; your own renames are kept as typed (up to 30 characters).

**By site category** uses the address only and makes no model request. The taxonomy covers common services such as Socials, Email, AI, Code, media, work, commerce, and personal administration. Recognised services can split into service-specific groups when a category becomes crowded. Explicit user rules still take precedence.

## Engines

| Engine | Processing | Credentials |
| --- | --- | --- |
| Offline smart mode (default) | Local engine on this device | None |
| Google Gemini | Google Gemini API | User API key |
| Anthropic · Claude | Anthropic Messages API; host access allowed when chosen | User API key |
| OpenAI | OpenAI chat completions | User API key or bearer token |
| xAI · Grok | xAI API | User API key |
| Groq | Groq OpenAI-compatible API | User API key |
| OpenRouter | OpenRouter routing API | User API key where required |
| DeepSeek | DeepSeek OpenAI-compatible API | User API key |
| Cerebras | Cerebras API | User API key |
| Ollama | Configured server; `http://localhost:11434` by default | Optional |

Cloud model catalogs are fetched from the configured provider and shown in a dropdown, with a **Custom model** option. Settings fetches the catalog when it opens on a provider, when you finish editing a credential, after Save and after a successful connection test, using the key currently typed even before Save; it sends no tab data. A listed model can still fail a cleanup. Cleanups request the lowest reasoning effort Foldnex offers for the model.

Anthropic's host is an optional permission: Chrome asks for it when you choose or save Anthropic or run its Test connection, and without it a cleanup with Anthropic runs locally and sends nothing. Removing the engine choice does not remove the grant; remove it at `chrome://extensions` if you want to. Anthropic requests carry the `anthropic-dangerous-direct-browser-access` header that Anthropic requires for requests from a browser origin; the key is sent only in `x-api-key` to the fixed address.

Cloud engines always use their provider's own address; a saved address override is ignored. An Ollama address must use HTTPS unless it is on this device, and must not contain credentials (any `@`), a query or a fragment; otherwise it is not used and cleanups run locally. Provider requests do not follow redirects. Loopback Ollama is the first hop: the request goes to the Ollama server on this device, and that server can itself run cloud models. A remote Ollama address receives tab titles and hints like a cloud engine. Changing the Ollama address does not grant access to a new host: requests remain subject to the hosts in `manifest.json` and Chrome's network rules.

## Install from source

Foldnex has no transpilation step and no runtime package dependencies.

1. Download or clone the repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the directory containing `manifest.json`.
5. After source changes, use **Reload** on the Foldnex extension card.

The manifest declares Chrome 120 as the minimum Chrome version. Store listing and submission material is maintained separately in [Chrome Web Store preparation](docs/development/chromewebstore.md). A store listing or its availability is not implied by this source installation path.

## Use Foldnex

- The first time you open the popup a setup card asks how Foldnex should sort your tabs: **Cloud AI** or **Offline smart mode**, or **Keep Ollama** when Ollama is already your engine. **Cloud AI** uses an engine you already saved a key for, or opens Settings so you can add one; your current engine stays in use until you save it. The card never blocks a cleanup.
- Open the popup and choose **Clean up and group**, or use the suggested shortcut `Alt+G` (Windows, Linux) or `Command+Shift+G` (macOS) while Chrome is focused. `Alt+U` or `Command+Shift+U` ungroups the current window. Check current assignments at `chrome://extensions/shortcuts`.
- Choose **By task** or **By site category**.
- In Behaviour settings, enable direct toolbar execution, **Auto-group new tabs**, or collapsed groups.

**Ungroup current window** removes groups; it does not restore duplicate tabs that were closed.

The popup reports groups created, duplicates removed, tabs added by plan upkeep, a waiting late plan and any offline fallback. Settings keeps privacy-safe run diagnostics (engine, source, group names and sizes, tokens, latency, quality flags) and separate provider-request totals.

## Configure providers and rules

Open **Rules and settings** from the popup or the extension Options action. Select an engine, enter a provider credential when needed, select a model or choose **Custom model**, and save. **Test connection**, beside the API-key field, sends one grouping request for two synthetic tabs with the key currently typed and does not send the current window. Settings opens in a regular window, even from a private window's popup, so its model lists and Test connection are regular-window requests. OpenAI defaults to `gpt-6-luna`; its **Priority processing** setting, on by default, sends `service_tier: "priority"`, and off sends `service_tier: "default"`. The provider determines the returned tier and billing. Ollama on a loopback address also has **Model memory**, sent to Ollama as `keep_alive`.

API keys and bearer tokens are stored in `chrome.storage.local`, restricted to trusted extension contexts. Legacy Sync credentials are moved to local storage on settings load without overwriting newer or explicitly cleared values. Non-secret preferences may use `chrome.storage.sync`. Explicit URL rules can be searched, added, exported, imported, deleted, or cleared; a pattern is a hostname with an optional path, is case-insensitive, uses `*` as its only wildcard, and is limited to 200 characters. Exports are browser downloads you delete separately. **Clear all rules** also clears exact results, name memory and rename preferences. Clear a credential field and save to replace a stored credential. **Clear run history** and **Clear provider usage** are separate.

## Privacy boundaries

Foldnex does not use content scripts and does not read page bodies, cookies, keystrokes, or form submissions. With a cloud engine or Ollama and By task, a cleanup you run sends at most one request for the current window (Anthropic only: a second, identical request without the thinking or effort setting after an HTTP 400 that rejects it): each eligible tab's title (up to 160 characters) and a host/path hint, which for web addresses has no query string, fragment or credentials. Rule and Socials tabs are not sent, and private (Incognito) windows send nothing, whatever engine is selected: By task uses Offline smart mode and By site category stays local. A window with a current applied plan, or with at most 10% new or changed tabs since the last model plan, sends nothing. Credentials go only to their provider's own address (or the checked Ollama address), never through a redirect, and Settings uses the key currently typed, even before Save, to list models and test. Titles and paths can still contain sensitive information. Offline smart mode, By site category, Auto-group and the background send nothing. Ollama at a loopback address is the first hop: that server can itself run cloud models.

Foldnex stores rules, group-name memory (your renames for 90 days), rename preferences (no age limit, learned from any regular-window group you rename) and six-hour exact results in `chrome.storage.local`, matching tabs by fingerprints rather than raw titles or URLs, although group names and rule patterns can reflect what the tabs are about. Provider usage counts every request started, including failed ones. Window plans, late-plan offers and tab bookkeeping (kept even with Auto-group off) live in session storage until Chrome restarts or the extension reloads. Private-window cleanups save no results from the private window.

Read [privacy](docs/legal/privacy.md) for the full data contract and [terms](docs/legal/terms.md) for the usage terms.

## Development and verification

From the repository root, follow the [development workflow](.github/CONTRIBUTING.md#development) in the contributor guide:

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

The package script validates its listed files, writes `dist/foldnex-<version>.zip`, tests the archive, and writes its SHA-256 file. It packages Foldnex's `LICENSE` and the bundled font and word-table licences, but not documentation or store artwork. Browser behaviour still needs checking by loading the unpacked extension in Chrome, especially popup, settings, shortcuts, duplicate handling, and grouping.

## Repository map

```text
manifest.json          Manifest, permissions, hosts, options, and commands
background.js           Service worker, commands, badges, and run orchestration
popup.*                 Popup cleanup and engine-selection surface
options/*               Provider, rules, diagnostics, and behaviour settings
src/grouper.js          Deduplication, click budget, and Chrome tab-group orchestration
src/planner.js          Plan validation, names, and shared local rules
src/local-engine.js     Local clustering engine and new-tab attach
src/embedder.js         Reader for the packaged word-embedding table
src/label-vocabulary.js Category vocabulary used for local names
src/ai-engine.js        Provider catalog, model discovery, and the plan request
src/settings.js         Shared settings reads and local credential migration
src/provider-usage.js  Content-free provider inference request totals
src/background-classifier.js Auto-group new tabs (local attach)
src/site-clusterer.js   Deterministic site-category grouping
src/cache-engine.js     Sanitisation, rules, exact results, name memory, plans and offers
models/potion-base-4M.* Packaged word-embedding table, licence and checksums
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
[licensing](docs/legal/licensing.md) for how the two fit together. The store archive includes the `LICENSE` file. The bundled Material
Symbols font keeps its own Apache-2.0 notice and the bundled potion-base-4M word table its
MIT notice; see [third-party notices](docs/legal/third-party-notices.md).

<sub>© 2026 MAGRATHEAN UK LTD · <a href="https://github.com/magrathean-uk/.github/blob/main/LEGAL.md">Legal</a></sub>
