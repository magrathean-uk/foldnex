<h1 align="center">Foldnex</h1>

<p align="center">A free, MIT-licensed Chrome extension that removes duplicate tabs and organises the rest into tab groups.</p>

<p align="center">
  <a href="https://magrathean.uk/apps/foldnex/">Website</a> ·
  <a href="docs/index.md">Documentation</a> ·
  <a href="https://magrathean.uk/apps/foldnex/privacy/">Privacy</a>
</p>

## Overview

Foldnex is a Manifest V3 Chrome extension that removes conservative exact duplicate tabs and organises the remaining tabs in the current window into Chrome tab groups. It can classify by task with a selected local or optional cloud engine, or classify locally by site category.

## What it does

- Removes duplicate ordinary web pages while preferring a pinned tab, then the active tab, then the leftmost copy. A redundant pinned copy can close when the survivor remains pinned.
- Ignores ordinary document fragments when identifying duplicates, but keeps route-like fragments and keeps HTTP and HTTPS distinct.
- A short allowlist of stateless Chrome pages, including extensions, downloads, history, and bookmarks, may also be deduplicated by exact URL.
- Leaves pinned tabs and browser-internal, extension, and developer-tool pages outside grouping.
- Offers **By task**, which uses complete titles and sanitised URL context, and **By site category**, a deterministic local taxonomy.
- Falls back to the offline clusterer when a selected model is unavailable.
- Applies explicit URL rules and exact-cohort rename preferences before creating groups.
- Supports popup, toolbar, and keyboard-command workflows for the current Chrome window.

The extension operates on one window at a time and keeps incognito processing within the matching incognito boundary.

## Grouping choices

**By task** uses the selected engine to group tabs by purpose. Page titles are retained up to a 1,000-character defensive ceiling, while URL context is reduced to host and path hints. Results are checked against the current tab IDs and missing assignments are recovered.

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

- Open the popup and choose **Clean up and group**.
- Choose **By task** or **By site category**.
- Use `Alt+G` on Windows and Linux, or `Command+Shift+G` on macOS, to group the current window.
- Use `Alt+U` on Windows and Linux, or `Command+Shift+U` on macOS, to ungroup the current window.
- In Behaviour settings, enable direct toolbar execution or collapsed groups when needed.

**Ungroup all** removes groups; it does not restore duplicate tabs that were closed.

The popup reports groups created, duplicates removed, and offline fallback use. Settings keeps privacy-safe aggregate diagnostics such as engine, source, group count, token count when reported, latency, and quality flags.

## Configure providers and rules

Open **Rules and settings** from the popup or the extension Options action. Select an engine, enter a provider credential when needed, select or type a model, choose reasoning effort when offered, and save. **Test connection** sends two synthetic tabs and does not send the current window.

API keys and bearer tokens are stored in `chrome.storage.local`. Non-secret preferences may use `chrome.storage.sync`. Explicit URL rules can be searched, added, exported, imported, deleted, or cleared. Imported rule files are schema-validated and limited to 1 MB. Exact-result cache and rename preferences can also be cleared.

## Chrome Gemini Nano

Chrome's Prompt API depends on Chrome, device, policy, storage, and model-download eligibility. Foldnex checks the API at runtime. When Chrome reports the model as available, keep the popup open for Nano grouping. Toolbar and keyboard runs fall back to offline grouping if the extension context cannot access the Prompt API. Chrome's own diagnostic page is `chrome://on-device-internals`.

## Privacy boundaries

Foldnex does not use content scripts and does not read page bodies, cookies, keystrokes, or form submissions. For By task cloud grouping, the selected provider receives tab titles (up to 1,000 characters each) and sanitised host/path hints from the current window. URL credentials, query strings, and fragments are removed before prompting. Provider credentials are sent separately for authentication. Titles and paths can still contain sensitive information. By site category, Offline smart mode, and a working Chrome on-device model do not send tab data to a cloud provider. Incognito grouping runs do not persist rules, cache, diagnostics, or rename preferences. A cloud engine still receives that window's title and URL hints when selected. User changes to settings can still be saved.

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
src/grouper.js          Deduplication and Chrome tab-group orchestration
src/ai-engine.js        Provider catalog, model discovery, and AI requests
src/offline-clusterer.js Local fallback clustering
src/site-clusterer.js   Deterministic site-category grouping
src/cache-engine.js     Sanitisation, rules, cache, and scoped preferences
src/group-state.js      Programmatic group-update suppression
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
