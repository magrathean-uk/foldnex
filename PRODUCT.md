# Foldnex product contract

<!-- impeccable:product-schema 1 -->

## Platform

Chrome extension using Manifest V3, with no build step and no runtime package dependencies.

## Users

Chrome users with crowded windows who want to restore a usable tab strip without manually finding duplicates or sorting every page.

## Product purpose

One action should leave the current window visibly cleaner: a single sensible copy of each ordinary web page and a small number of task-oriented Chrome tab groups.

## Positioning

Foldnex is a practical tab-organisation utility, not an AI showcase. It combines conservative duplicate removal, local learned rules, optional AI classification, and an offline fallback rather than depending on one model or provider.

## Primary surfaces

- **Popup:** tab count, cleanup action, ungroup action, active engine, local-memory summary, and direct-toolbar preference.
- **Options:** one provider list with a shared configuration panel, learned-rule management, and behaviour preferences.
- **Toolbar and commands:** progress/result badge plus group and ungroup keyboard shortcuts.

## Core workflow

1. Resolve the active Chrome window and its incognito boundary.
2. Remove duplicate ordinary web pages using a conservative canonical URL.
3. Exclude pinned and browser-internal tabs from grouping.
4. Use learned rules when the entire remaining set is recognised.
5. Otherwise use the selected engine, with offline clustering as the failure fallback.
6. Validate every returned tab ID and reclaim omitted tabs.
7. Create groups in their existing left-to-right order and report the result.

## Duplicate-survivor contract

- Ignore fragments and normalise HTTP/HTTPS for page identity.
- Retain query keys, values, order, host, port, and path.
- Prefer a pinned survivor, then the active tab, then the leftmost copy.
- Recheck both survivor and candidate immediately before removal.
- Never deduplicate non-HTTP(S) URLs.

## Grouping contract

- Use each complete title as the primary semantic signal and its sanitised URL as supporting context.
- Group by active task or purpose, not simply by domain or media type.
- Produce concise names and only Chrome-supported colours.
- Assign every current groupable tab exactly once.
- Target two to six groups unless the actual tab set requires a safe fallback.
- Preserve natural tab order inside groups and group order across the strip.

## Engine strategy

- Local options are Chrome Gemini Nano and offline smart mode.
- Cloud options are Google Gemini, OpenAI, xAI Grok, Groq, OpenRouter, DeepSeek, and Cerebras.
- Ollama supports a configurable local OpenAI-compatible endpoint.
- Provider model catalogs are discovered live and cached for six hours.
- Groq with `qwen/qwen3.8-27b` is the recommended cloud configuration for the current structured grouping workload.
- Groq strict-schema responses are preferred where the selected model supports them.

## Data and privacy contract

- API keys and OAuth tokens live in `chrome.storage.local`, restricted to trusted extension contexts.
- Non-secret engine preferences may sync through Chrome.
- Cloud grouping sends complete titles and sanitised semantic URLs to the selected provider.
- Offline smart mode and a working Chrome on-device model do not make a cloud grouping request.
- Page bodies are never read; there are no content scripts.
- Incognito grouping does not write learned rules or learn from later group renames.
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
- API keys are absent from sync storage, Git history, exported rules, and user-facing logs.
- The popup and settings remain usable with keyboard focus, reduced motion, and narrow widths.
- Current ordinary-user browser behavior is checked separately from syntax and mocked-provider checks.

## Maintained evidence

- Behavior: `background.js`, `src/grouper.js`, `src/ai-engine.js`, `src/cache-engine.js`, and `src/offline-clusterer.js`.
- User surfaces: `popup.*` and `options/*`.
- Permissions and entry points: `manifest.json`.
- Product-facing setup and privacy guidance: `README.md`.
- Visual authority: `DESIGN.md` and `.impeccable/design.json`.
