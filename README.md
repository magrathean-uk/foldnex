# Foldnex

Foldnex is a Manifest V3 Chrome extension that removes duplicate pages and organises the remaining tabs in the current window into focused, named Chrome tab groups.

It combines learned local rules, an offline clusterer, Chrome's on-device Prompt API, and optional cloud AI providers. The interface follows a restrained Magrathean/Teslatlas design language and keeps engine configuration secondary to the main cleanup action.

## What it does

- Removes conservative, exact-page duplicates before grouping.
- Uses complete page titles and privacy-sanitised URLs to infer the user's active tasks.
- Creates two to six named groups with valid Chrome tab-group colours.
- Preserves pinned and browser-internal tabs instead of attempting to group them.
- Learns reusable URL-pattern rules from successful groupings and manual group renames.
- Falls back to the offline clusterer when a selected AI provider is unavailable.
- Supports popup, toolbar, and keyboard-driven workflows.

## Duplicate handling

Foldnex treats two ordinary HTTP(S) tabs as duplicates when their normalised page identity matches:

- URL fragments are ignored because they normally identify a position within the same document.
- HTTP and HTTPS variants are treated as the same location.
- Host, explicit port, path, query keys, query values, and query order remain significant.
- Pinned tabs win; otherwise Foldnex keeps the active tab, then the leftmost copy.
- Chrome pages, extension pages, developer tools, and other non-web URLs are never removed as duplicates.

The tab list is refreshed after duplicate removal, so only surviving tabs are classified and grouped.

## Grouping engines

All engines appear in one list in the popup and settings page.

| Engine | Runs | Authentication | Notes |
| --- | --- | --- | --- |
| Chrome Gemini Nano | On device | None | Uses Chrome's Prompt API when available in an extension page. |
| Offline smart mode | On device | None | URL structure and title-keyword clustering with no model request. |
| Google Gemini | Cloud | API key | Uses Google's Gemini API and live model catalog. |
| OpenAI | Cloud | API key or OAuth token | OpenAI-compatible chat completions. |
| xAI · Grok | Cloud | API key | Grok models through xAI. |
| Groq | Cloud | API key | Recommended cloud path for fast tab grouping. |
| OpenRouter | Cloud | API key where required | Multi-provider model routing. |
| DeepSeek | Cloud | API key | OpenAI-compatible DeepSeek endpoint. |
| Cerebras | Cloud | API key | Low-latency open-model inference. |
| Ollama | Local | Optional | User-configurable local OpenAI-compatible endpoint. |

Provider model fields are populated from each provider's live models endpoint and cached for six hours. A model ID can also be entered manually when it is not returned by the catalog.

### Recommended Groq configuration

The Groq default is `qwen/qwen3.8-27b`. Foldnex uses Groq's strict JSON Schema output for supported models and disables Qwen reasoning for this constrained classification task, reducing latency and unnecessary output tokens.

Every complete tab title is preserved. Control characters are neutralised, the records are encoded as JSON, and the prompt explicitly treats them as untrusted data rather than instructions. URLs are reduced to semantic host/path information and an allowlist of useful query parameters before leaving the extension.

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
- Press `Alt+G` on Windows/Linux or `Command+Shift+G` on macOS to group the current window.
- Press `Alt+U` on Windows/Linux or `Command+Shift+U` on macOS to ungroup the current window.
- Enable **Run directly from toolbar** in Behaviour settings to make the toolbar icon run grouping without opening the popup.
- Enable **Collapse groups after creation** if newly created groups should start collapsed.

The toolbar badge shows progress and then the number of groups created. The popup reports groups created, duplicates removed, and whether the offline fallback was used.

## Configure an engine

1. Open **Rules and settings** from the popup, or use Chrome's extension Options action.
2. Choose an engine from the unified list.
3. For a cloud provider, enter its API key, select or type a model, and save the provider.
4. Use **Test connection** to make a minimal provider request.

Secrets are stored in `chrome.storage.local`, restricted to trusted extension contexts, and removed from Chrome sync storage. Provider choice, model IDs, base URLs, and non-secret preferences may use `chrome.storage.sync`.

Selecting a cloud engine means complete tab titles and sanitised URLs from the current window are sent to that provider when grouping runs. Offline smart mode and Chrome Gemini Nano do not send that tab data to a cloud provider.

## Chrome Gemini Nano

Chrome's built-in model depends on Chrome, operating-system, hardware, storage, policy, and model-download eligibility. Foldnex detects the current Prompt API instead of relying on obsolete flags.

1. Use a current Chrome release on supported hardware.
2. Open Foldnex settings and choose **Chrome Gemini Nano**.
3. If Chrome reports the model as downloadable, select **Download local model** and keep the page open while it prepares.
4. Use `chrome://on-device-internals` for Chrome's own diagnostic state when detection fails.

The Prompt API is normally available to extension documents rather than the Manifest V3 service worker. Keep the Foldnex popup open for Nano grouping. Toolbar-direct and keyboard runs safely fall back to offline grouping when Chrome does not expose the API in that context.

## Learned rules

Foldnex stores learned URL-pattern rules locally and can classify a fully recognised window without a network request. In settings you can:

- Search, add, or delete rules.
- Choose a group name and Chrome colour for a manual wildcard rule.
- Export rules as JSON.
- Import a validated JSON rules file of up to 1 MB.
- Clear all learned rules.

Manual group renames teach Foldnex the new category. Persistent learning is skipped in incognito windows.

## Privacy and safety boundaries

- API keys stay in local extension storage and are not committed to this repository.
- Cloud requests contain complete titles because that context materially improves grouping accuracy.
- URLs are stripped of credentials, fragments, tracking data, and non-allowlisted query parameters before prompting.
- Prompt output is validated against current numeric tab IDs; missing tabs are reclaimed into an `Other` group.
- Grouping is limited to one Chrome window and respects its incognito boundary.
- The extension has no content scripts and does not read page bodies.

## Project structure

```text
background.js          Service worker, commands, badges, and learning events
popup.html/.css/.js    Compact cleanup and engine-selection surface
options/               Provider, learned-rule, and behaviour settings
src/ai-engine.js       Provider catalog, live model discovery, and AI requests
src/grouper.js         Deduplication and Chrome tab-group orchestration
src/cache-engine.js    Local learned-pattern memory and sanitisation
src/offline-clusterer.js
                       Zero-cloud fallback clustering
DESIGN.md              Maintained visual-system reference
PRODUCT.md             Product scope and behavioural contract
```

## Development and verification

There is no transpilation or packaging step. Before loading or publishing a change:

```sh
for file in background.js popup.js options/options.js src/*.js; do
  node --check "$file"
done
git diff --check
```

For behavior that depends on Chrome APIs, reload the unpacked extension and verify the relevant popup, settings, shortcut, deduplication, and grouping flow in Chrome. A successful provider connection test does not replace a current-window grouping check.

## Documentation

- [Product contract](PRODUCT.md)
- [Design system](DESIGN.md)
- [Repository guidance](AGENTS.md)
