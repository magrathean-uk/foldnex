# Foldnex product contract

<!-- impeccable:product-schema 1 -->

## Platform

Chrome extension using Manifest V3, with no build step and no runtime package dependencies.

## Users

Chrome users with crowded windows who want to restore a usable tab strip without manually finding duplicates or sorting every page.

## Product purpose

One action should leave the current window visibly cleaner: a single sensible copy of each ordinary web page and a small number of task-oriented Chrome tab groups.

## Positioning

Foldnex is a practical tab-organisation utility, not an AI showcase. It combines conservative duplicate removal, exact semantic result reuse, explicit user rules, optional AI classification, and an offline fallback rather than depending on one model or provider.

## Primary surfaces

- **Popup:** tab count, cleanup action, ungroup action, grouping strategy, active task engine, local-memory summary, and direct-toolbar preference.
- **Options:** one provider list with a shared configuration panel, rules and semantic-memory management, privacy-safe run diagnostics, and behaviour preferences.
- **Toolbar and commands:** progress/result badge plus group and ungroup keyboard shortcuts.

## Core workflow

1. Resolve the active Chrome window and its incognito boundary.
2. Remove duplicate ordinary web pages and allowlisted stateless Chrome pages using a conservative canonical URL.
3. Exclude pinned and browser-internal tabs from grouping.
4. If By site category is selected, classify locally from the address using the stable service taxonomy and site-name fallback.
5. Otherwise reuse a cached result only when the complete semantic tab set is unchanged, then use the selected engine holistically with offline clustering as the failure fallback.
6. Apply exact scoped rename preferences and explicit user-authored URL overrides.
7. Validate every returned tab ID; for By task results, run a bounded semantic quality check and reclaim omitted tabs.
8. Create groups in their existing left-to-right order and report privacy-safe diagnostics.

## Duplicate-survivor contract

- Ignore ordinary document anchors but preserve route-like fragments.
- Keep HTTP and HTTPS identities distinct.
- Retain query keys, values, order, host, port, and path.
- Prefer a pinned survivor, then the active tab, then the leftmost copy.
- Recheck both survivor and candidate immediately before removal.
- Deduplicate exact URLs for a short allowlist of stateless Chrome pages; preserve other non-HTTP(S) pages.

## Grouping contract

- **By task** uses each complete title as the primary semantic signal and its sanitised URL as supporting context.
- **By task** groups by active task or purpose, not simply by domain or media type.
- **By site category** uses only the address and makes no model request. Known services use a stable 30-name taxonomy. X, Reddit, and Slack are Socials; Gmail and Outlook are Email; assistants such as ChatGPT and Grok are AI · Assistants; AI provider consoles and documentation are AI · Platforms. AI groups never merge into Code, Cloud, or generic technology groups.
- In either strategy, known social services are kept in Socials rather than accepted inside system or administration groups. Explicit user-authored URL overrides still take precedence.
- By site category keeps every page under the same recognised base site together, including separate Envato account, asset, and content areas.
- YouTube, Envato, and Tesla are atomic dedicated groups. A multi-service category exceeding 15 tabs splits deterministically at service boundaries with namespaced labels such as Socials · X and AI · ChatGPT.
- Repeated unknown sites use a readable site name. One-off unknowns enter Review Later groups capped at eight tabs rather than producing one group per tab or one unbounded catch-all.
- Produce concise names and only Chrome-supported colours.
- Assign every current groupable tab exactly once.
- In By task mode, use an adaptive group range based on tab count and diversity: up to eight groups for ordinary windows and up to fourteen for windows above 140 tabs.
- In By task mode, reject vague catch-all groups containing more than two tabs and retry once with the failed quality constraint.
- In By task mode, reject regional labels contradicted by a member's country-code domain and retry with an accurate country, region, or inclusive parent-region label.
- In By task mode, cap large groups at roughly 28% of ordinary windows and 20% above 80 tabs (minimum cap eight) so one broad theme cannot swallow distinct tasks or regions. By site category deliberately permits large same-site groups.
- Preserve natural tab order inside groups and group order across the strip.

## Engine strategy

- Local options are Chrome Gemini Nano and offline smart mode.
- Cloud options are Google Gemini, OpenAI, xAI Grok, Groq, OpenRouter, DeepSeek, and Cerebras.
- Ollama uses its fixed loopback endpoint at `http://localhost:11434`.
- By site category is a deterministic local strategy independent of the selected task engine and consumes no provider tokens.
- Site-category grouping does not request browser-history permission. The generic public taxonomy is maintained in source; personal mappings remain explicit local rules.
- Provider model catalogs are discovered live and cached for six hours.
- Groq with `qwen/qwen3.8-27b` is the default cloud configuration for the current grouping workload, selected from a live 36-tab comparison for better grouping quality with fewer generated tokens.
- Groq uses JSON-object output plus local ID, coverage, color, and quality validation. This avoids strict-schema `failed_generation` errors that can otherwise turn a recoverable assignment into an HTTP 400.

## Data and privacy contract

- API keys and bearer tokens live in `chrome.storage.local`, restricted to trusted extension contexts.
- Non-secret engine preferences may sync through Chrome.
- Cloud By task grouping sends complete titles and URL host/path hints to the selected provider; credentials, query strings, and fragments are removed first.
- By site category, offline smart mode, and a working Chrome on-device model do not make a cloud grouping request.
- Page bodies are never read; there are no content scripts.
- Incognito grouping does not write rules, exact results, diagnostics, or group-rename preferences. If a cloud engine is selected, its normal title and host/path transmission still applies.
- Programmatic group updates are marked in shared session storage and cannot become user corrections.
- Imported rule files are size-limited and schema-validated before storage.

## Chrome on-device constraint

The Prompt API may be available in extension documents but absent from a Manifest V3 service worker. Popup-based Nano grouping is supported when Chrome reports the model ready. Background-triggered runs must fall back safely rather than claiming on-device inference occurred.

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

- Duplicate removal preserves the correct survivor and reports the count.
- Every surviving groupable tab is assigned to a group even when model output is incomplete.
- Pinned, internal, vanished, or newly navigated tabs are handled without destructive assumptions.
- A provider failure produces an offline result and communicates that fallback.
- An unchanged semantic window can reuse a result, while any title or semantic URL change causes fresh classification.
- By site category keeps all Envato pages together, gives YouTube its own group, separates Socials from Email and AI from Code, and makes no provider request.
- A deterministic 200-tab fixture assigns every tab once, produces no more than 30 groups, and repeats the same names and membership on every run.
- Last-run diagnostics identify the actual engine, source, token usage, latency, groups, duplicates, fallback class, and quality flags without retaining tab content.
- API keys are absent from sync storage, Git history, exported rules, and user-facing logs.
- The popup and settings remain usable with keyboard focus, reduced motion, and narrow widths.
- Current ordinary-user browser behavior is checked separately from syntax and mocked-provider checks.

## Maintained evidence

- Behavior: `background.js`, `src/grouper.js`, `src/ai-engine.js`, `src/cache-engine.js`, `src/group-state.js`, `src/offline-clusterer.js`, and `src/site-clusterer.js`.
- User surfaces: `popup.*` and `options/*`.
- Permissions and entry points: `manifest.json`.
- Product-facing setup and privacy guidance: `README.md`.
- Visual authority: `DESIGN.md` and `.impeccable/design.json`.
