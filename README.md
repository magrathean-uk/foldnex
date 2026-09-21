# Foldnex

Foldnex is a Manifest V3 Chrome extension that removes duplicate pages and organises the remaining tabs in the current window into focused, named Chrome tab groups.

It combines exact semantic result reuse, explicit local rules, an offline clusterer, Chrome's on-device Prompt API, and optional cloud AI providers. 

## What it does

- Removes conservative, exact-page duplicates before grouping.
- Offers two grouping strategies: title-aware **By task** and deterministic **By site category**.
- Uses complete page titles and privacy-sanitised URLs to infer the user's active tasks in By task mode.
- Keeps same-site pages together in By site category mode and maps known services into stable categories such as Socials and AI.
- Uses an adaptive group range based on the size and diversity of the window, allowing extra groups in very large windows instead of forcing unrelated tabs together.
- Preserves pinned and browser-internal tabs instead of attempting to group them.
- Reuses only an unchanged semantic tab set; changed titles return to title-aware classification.
- Applies explicit URL rules and remembers manual group renames only for the exact renamed cohort.
- Falls back to the offline clusterer when a selected AI provider is unavailable.
- Supports popup, toolbar, and keyboard-driven workflows.

## Duplicate handling

Foldnex treats two pages as duplicates when their conservative page identity matches:

- Ordinary document-anchor fragments are ignored, while route-like fragments such as `#/settings` remain significant.
- HTTP and HTTPS remain distinct.
- Host, explicit port, path, query keys, query values, and query order remain significant.
- Pinned tabs win; otherwise Foldnex keeps the active tab, then the leftmost copy.
- Exact duplicates of `chrome://extensions`, downloads, history, and bookmarks may be removed.
- Other Chrome pages, extension pages, developer tools, and non-web URLs are never removed as duplicates.

The tab list is refreshed after duplicate removal, so only surviving tabs are classified and grouped.

## Grouping strategies

- **By task** is the default. It uses the selected grouping engine, complete page titles, and sanitised URL context to separate distinct tasks even when they share a domain.
- **By site category** runs locally without an AI request. It uses a stable 30-name taxonomy derived from aggregated browsing patterns: AI assistants, AI platforms, social, email, media, creative work, engineering, work, discovery, commerce, and personal administration. Envato account, asset, and content pages remain together as **Envato**; YouTube and Tesla also receive dedicated groups.

AI assistants such as ChatGPT, Grok, Claude, Gemini, and Perplexity are grouped as **AI · Assistants**. Provider consoles and documentation such as OpenAI, Groq, Hugging Face, and OpenRouter are **AI · Platforms**. Neither category can fall into Code, Cloud, or generic technology groups. X, Reddit, Slack, and similar services are **Socials**, while Gmail and Outlook are **Email**. This social guardrail also applies to title-aware grouping, before any explicit user-authored URL override.

For crowded 100–200-tab windows, a multi-service category splits after 15 tabs at stable site boundaries. Examples include **Socials · X**, **Socials · Reddit**, **AI · ChatGPT**, and **AI · Grok**. Dedicated services such as YouTube and Envato stay whole. Repeated unknown sites use their readable site name; unrelated one-off sites enter bounded **Review Later** groups of at most eight tabs.

Choose the strategy in the popup or under **Behaviour** in settings. Explicit URL rules still take precedence in either mode. The extension does not request Chrome history access; the taxonomy is static and personal site mappings stay in local rules rather than source control.

## Grouping engines

All engines appear in one list in the popup and settings page.

| Engine | Runs | Authentication | Notes |
| --- | --- | --- | --- |
| Chrome Gemini Nano | On device | None | Uses Chrome's Prompt API when available in an extension page. |
| Offline smart mode | On device | None | URL structure and title-keyword clustering with no model request. |
| Google Gemini | Cloud | API key | Uses Google's Gemini API and live model catalog. |
| OpenAI | Cloud | API key or bearer token | OpenAI-compatible chat completions. |
| xAI · Grok | Cloud | API key | Grok models through xAI. |
| Groq | Cloud | API key | Recommended cloud path for fast tab grouping. |
| OpenRouter | Cloud | API key where required | Multi-provider model routing. |
| DeepSeek | Cloud | API key | OpenAI-compatible DeepSeek endpoint. |
| Cerebras | Cloud | API key | Low-latency open-model inference. |
| Ollama | Local | Optional | Uses Ollama on the fixed local endpoint `http://localhost:11434`. |

Provider model fields are populated from each provider's live models endpoint and cached for six hours. A model ID can also be entered manually when it is not returned by the catalog.

### Recommended Groq configuration

The Groq default is `qwen/qwen3.8-27b`. On a saved 36-tab acceptance window it produced a substantially cleaner, lower-token result than `openai/gpt-oss-20b`, especially when asked to split a large same-domain bucket by purpose. Foldnex uses JSON-object output, compact local tab ordinals, local coverage and quality validation, and a bounded completion budget. Users can still select any compatible model returned by Groq's live catalog.

Every complete tab title is preserved up to a defensive 1,000-character ceiling. Control characters are neutralised, the records are encoded as compact JSON, and the prompt explicitly treats them as untrusted data rather than instructions. URLs are reduced to host/path hints; credentials, query strings, and fragments are removed before leaving the extension.

For an unchanged tab set, Foldnex reuses a content-addressed local result for up to six hours. A changed title or semantic URL hint invalidates that result. Broad domain rules produced by earlier AI runs never bypass title-aware grouping.

## Install from source

Foldnex has no build step or runtime package dependencies.

1. Clone or download this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the repository directory containing `manifest.json`.
5. Pin Foldnex from Chrome's Extensions menu if desired.

After changing source files, use **Reload** on the Foldnex card at `chrome://extensions`.

## Use Foldnex

- Open the popup and select **Clean up and group**.
- Choose **By task** for title-aware grouping or **By site category** to keep sites together locally.
- Press `Alt+G` on Windows/Linux or `Command+Shift+G` on macOS to group the current window.
- Press `Alt+U` on Windows/Linux or `Command+Shift+U` on macOS to ungroup the current window.
- Enable **Run directly from toolbar** in Behaviour settings to make the toolbar icon run grouping without opening the popup.
- Enable **Collapse groups after creation** if newly created groups should start collapsed.

The toolbar badge shows progress and then the number of groups created. The popup reports groups created, duplicates removed, and whether the offline fallback was used. Settings shows privacy-safe last-run diagnostics including engine, source, group counts, token usage, latency, and quality flags.

## Configure an engine

1. Open **Rules and settings** from the popup, or use Chrome's extension Options action.
2. Choose an engine from the unified list.
3. For a cloud provider, enter its API key, select or type a model, and save the provider.
4. Use **Test connection** to make a minimal provider request.

Secrets are stored in `chrome.storage.local`, restricted to trusted extension contexts, and removed from Chrome sync storage. Provider choice, model IDs, base URLs, and non-secret preferences may use `chrome.storage.sync`.

Selecting a cloud engine means complete tab titles and host/path URL hints from the current window are sent to that provider when By task grouping runs. This also applies in incognito if the user explicitly selects a cloud engine there; incognito runs do not write cache, diagnostics, rules, or preferences. By site category, offline smart mode, and Chrome Gemini Nano do not send that tab data to a cloud provider.

## Chrome Gemini Nano

Chrome's built-in model depends on Chrome, operating-system, hardware, storage, policy, and model-download eligibility. Foldnex detects the current Prompt API instead of relying on obsolete flags.

1. Use a current Chrome release on supported hardware.
2. Open Foldnex settings and choose **Chrome Gemini Nano**.
3. If Chrome reports the model as downloadable, select **Download local model** and keep the page open while it prepares.
4. Use `chrome://on-device-internals` for Chrome's own diagnostic state when detection fails.

The Prompt API is normally available to extension documents rather than the Manifest V3 service worker. Keep the Foldnex popup open for Nano grouping. Toolbar-direct and keyboard runs safely fall back to offline grouping when Chrome does not expose the API in that context.

## Rules and memory

Foldnex stores explicit URL-pattern rules locally. These are authoritative user overrides, not automatic guesses. In settings you can:

- Search, add, or delete rules.
- Choose a group name and Chrome colour for a manual wildcard rule.
- Export rules as JSON.
- Import a validated JSON rules file of up to 1 MB.
- Clear rules, scoped rename preferences, and the exact-result cache.

Manual group renames are remembered only for that exact semantic cohort. Programmatic Foldnex updates are suppressed through shared session state so they cannot be mistaken for user corrections. Persistent memory and diagnostics are skipped in incognito windows.

When upgrading from the original URL-learning implementation, legacy rules are quarantined locally and active rules start clean because the earlier format could not reliably distinguish user corrections from programmatic grouping.

## Privacy and safety boundaries

- API keys stay in local extension storage and are not committed to this repository.
- Cloud requests contain complete titles because that context materially improves grouping accuracy.
- URLs are stripped of credentials, query strings, and fragments before prompting.
- Prompt output uses small local ordinals and is validated back against current Chrome tab IDs; missing tabs are reclaimed and trigger a semantic quality retry when needed.
- Grouping is limited to one Chrome window and respects its incognito boundary.
- The extension has no content scripts and does not read page bodies.

## Project structure

```text
background.js          Service worker, commands, badges, and learning events
popup.html/.css/.js    Compact cleanup and engine-selection surface
options/               Provider, learned-rule, and behaviour settings
src/ai-engine.js       Provider catalog, live model discovery, and AI requests
src/grouper.js         Deduplication and Chrome tab-group orchestration
src/cache-engine.js    Exact-result cache, explicit rules, scoped preferences, and sanitisation
src/group-state.js     Cross-context programmatic group-update suppression
src/offline-clusterer.js
                       Zero-cloud fallback clustering
src/site-clusterer.js  Deterministic address and service-category grouping
DESIGN.md              Maintained visual-system reference
PRODUCT.md             Product scope and behavioural contract
```

## Development and verification

There is no transpilation step. Before loading or publishing a change:

```sh
npm test
for file in background.js popup.js options/options.js src/*.js; do
  node --check "$file"
done
git diff --check
```

Create the Chrome Web Store upload ZIP with:

```sh
npm run package:store
```

The command writes a deterministic runtime-only archive and checksum under `dist/`. Store copy, permission justifications, reviewer instructions, and the dashboard checklist are maintained in [`CHROMEWEBSTORE.md`](CHROMEWEBSTORE.md).

For behavior that depends on Chrome APIs, reload the unpacked extension and verify the relevant popup, settings, shortcut, deduplication, and grouping flow in Chrome. A successful provider connection test does not replace a current-window grouping check.

## Documentation

- [Product contract](PRODUCT.md)
- [Design system](DESIGN.md)
- [Privacy policy](PRIVACY.md)
- [Chrome Web Store submission](CHROMEWEBSTORE.md)
- [Repository guidance](AGENTS.md)
