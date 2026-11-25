# Changelog

This changelog summarises source changes. A version entry does not establish Chrome Web Store approval or public availability.

## 2.3.0

Release candidate, 25 November 2026. Not yet submitted to the Chrome Web Store. Behaviour, permissions, stored data and what is sent to providers are unchanged from 2.2.0.

### Design

- Redesigned the popup and Settings. The popup leads with the tab count and one **Clean up and group** button; results, warnings and the late-plan **Apply** appear directly under it.
- Settings uses titled groups with a sentence of help and a label column, instead of boxed headers and all-caps labels. The engine chooser shows local engines and cloud providers in two labelled columns.
- Destructive clears (**Clear all rules**, **Clear run history**, **Clear provider usage**) sit apart at the end of their group, in red, with a line on what they remove.
- Added a dark theme that follows the system setting. Text and controls meet WCAG AA contrast in both themes; focus is always visible; reduced motion is respected.
- Colours, type sizes, spacing, radii and elevation are defined once in `tokens.css` and shared by both pages.
- New store screenshots from the 2.3.0 design, including the popup.

## 2.2.0

Release candidate, 25 November 2026. Not yet submitted to the Chrome Web Store.

### Engines

- Added **Anthropic · Claude** as a cloud engine. It plans the window in one request to Anthropic's Messages API at the fixed address `https://api.anthropic.com/v1`, with the same local checks, click budget, late-plan offer, stored plans and upkeep as the other cloud engines. No SDK: plain `fetch`, as for the other engines.
- Default model `claude-opus-5-5` at low effort. Thinking and effort follow the model: Sonnet 5.5 is sent with thinking off (`between_tools`); Haiku 5.5 and the other models that support effort and can turn thinking off are sent `thinking: disabled`; models that cannot turn it off get `effort: low`; `claude-haiku-4-5`, `claude-sonnet-4-5`, any listed model without effort support and an unknown model get neither field. The chosen model's capabilities, as Settings listed them, are saved with the settings so Settings, the popup and the service worker send the same fields; an unknown model also gets reasoning headroom in its output budget. No sampling parameters or prefill; the answer format is set by structured output.
- Compatibility retry: if Anthropic rejects the thinking or effort setting with HTTP 400, a cleanup or Test connection repeats the same request once without it. This is the one case of a second request, and the privacy page says so. The per-run diagnostics count plans, the usage totals count HTTP requests.
- Models that support it ask Anthropic to fall back to another of its models on a refusal (`fallbacks: "default"`). A final refusal, or an answer cut off at its output limit, ends the request and the cleanup groups locally.
- Settings lists Claude models from Anthropic's Models API and offers an effort only where the model supports one.
- Provider usage records Anthropic's input, output, cache-read and cache-write tokens.
- Measured on the twelve evaluation windows: 0.88 F1 over all tabs, 3.28 s median and 3.58 s p90 per window over 24 requests (windows of 69 to 200 tabs had a p90 of 5.77 s), about 2.2 US cents per window (`eval/results/provider/phase1-engines/report.md`).

### Permissions and privacy

- `https://api.anthropic.com/*` is an **optional** host permission, so the update adds no install-time warning. Foldnex asks Chrome for it when you choose or save Anthropic, or run its Test connection, in Settings, in the popup's engine list or in the setup card.
- Without the permission nothing is sent to Anthropic: a cleanup groups locally and says that access must be allowed in Settings, and the popup shows **Access needed**. Choosing another engine does not remove the grant.
- Anthropic keys are stored in local extension storage like the other keys and sent only in the `x-api-key` header to the fixed address, never through a redirect. Requests carry the `anthropic-dangerous-direct-browser-access` header Anthropic requires from a browser origin. Private windows send nothing, as for every engine.
- Privacy policy and terms name Anthropic as a recipient of titles and hints when chosen.

## 2.1.0

Release candidate, 23 November 2026. Not yet submitted to the Chrome Web Store.

### Grouping

- With a cloud engine or Ollama, a cleanup sends at most one plan request for the window and the model returns named groups. Foldnex checks and repairs the answer locally (each tab placed at most once, names checked, at most ten groups of its own apart from rule and Socials groups) and applies it. Per-tab category labels, their batches and the naming and consolidation requests are removed.
- Added a local engine used by Offline smart mode and by a failed or late request: it clusters tab titles and address words with a packaged word table (potion-base-4M, MIT, see the third-party notices) and sends no request.
- Added plan upkeep: in a regular window an unchanged window reuses its applied plan, and when at most 10% of its tabs are new or changed since the last model plan, those tabs join the plan's groups on the device or wait in Review Later, with no request.
- A plan that arrives after the click's wait (about 5.4 seconds) and still matches the window is offered in the popup with **Apply**; it never regroups the strip on its own.
- Auto-group new tabs now attaches a new tab to an existing matching group on the device, in By task on every engine, and never sends a request.
- Rule and Socials tabs are not sent to a model.
- Plan requests use the lowest reasoning effort Foldnex offers for the model.

### Privacy and security

- Private (Incognito) windows send nothing, whatever engine is selected: By task uses Offline smart mode and By site category stays local.
- Cloud engines always use their provider's own address; a saved address override is ignored. An Ollama address must use HTTPS unless it is on this device, and must not contain credentials (any `@`), a query or a fragment; otherwise it is not used and cleanups run locally. Provider requests do not follow redirects.
- Loopback Ollama is the first hop: the request goes to the Ollama server on this device, and that server can itself run cloud models.
- The URL hint masks long identifiers in whole path segments, then keeps at most 80 path characters, as in 2.0.
- The popup and Settings name only the endpoint a request would use; a saved Ollama address that is refused is shown as not used.
- Run diagnostics record the configured model, not the model name a provider returns. Console messages hold no group names.
- Plan answers and the Gemini model catalogue are read within fixed bounds.

### Removed

- Chrome Gemini Nano is no longer an engine. A saved Nano choice, and its setup choice, become Offline smart mode the first time settings load after the update. Foldnex then deletes the stored per-tab labels and Nano's timing memory, retrying a failed removal on a later load.
- Removed background preparation, the Nano model-memory controls and Cloud economy mode, with their saved settings. Ollama on this device keeps its unload setting.
- The background no longer sends or prepares anything on any engine.

### Settings and store

- Setup card: Cloud AI or Offline smart mode (Keep Ollama where it applies). New installs start on Offline smart mode.
- Settings copy states that cleanups use the lowest reasoning effort, that a typed key is used to list models before Save, and that provider usage counts failed requests.
- The store archive now includes Foldnex's own `LICENSE`.
- Product links moved to `https://magrathean.uk/solutions/foldnex/`.
- Store screenshots that showed Gemini Nano or removed copy were replaced with automated captures of 2.1.0 (02 with seeded example totals, 05 with a loopback stand-in model list).

### What you need to know

- If you used Gemini Nano, Foldnex now uses Offline smart mode. Choose a cloud engine or Ollama in Settings for model-quality groups.
- No new permission.
- The 2.1.0 archive is 3.9 MB because of the word table; the release plan records the previous package at 0.2 MB.
- Measured on twelve synthetic evaluation windows (906 tabs, pairwise F1 over all tabs against hand-made task groups): a plan from Claude Sonnet 5.5, measured directly against the Claude API, scored 0.84 and OpenAI's default model 0.74 to 0.77, against 0.42 for 2.0-style per-tab labels; the local engine scored 0.39, against 0.19 for 2.0's local rules. The other engines' default models are not yet measured. See `docs/development/grouping-fix-plan.md` and `eval/results/rescore.md`.

## Documentation refresh — 6 October 2026

- Added a user guide covering setup, engines, background work, memory, rules, diagnostics and troubleshooting.
- Reconciled product, design, privacy, terms, support and contributor documentation with the 2.0 implementation.
- Simplified proposed store copy and documented optional provider charges and OpenAI Priority pricing.
- Documented Chrome Web Store API v2 service-account setup, upload, submission and status verification.
- Replaced five store screenshots with full-bleed 1280×800 crops of owner-supplied 2.0.0 captures, retained their originals and added a repeatable artwork helper.
- Qualified earlier Nano measurements and corrected retention/reset descriptions.
- Kept existing working product/legal links while the solutions URL migration remains pending.

These are documentation changes; they do not change the extension runtime or its permission contract.

## 2.0.0

Developed across the 29–30 September 2026 changes. Submitted to the Chrome Web Store on 6 October 2026; the API reported pending review at submission. Check the dashboard for current status.

### Grouping

- Replaced direct model-created groups with fixed-category tab labels and a local planner.
- Added coherent task grouping, protected explicit rules and Socials, bounded merges, deterministic fallback names and model-name validation.
- Scoped model labels, names and merge advice to engine/model/effort/endpoint; preserved labels across planner corrections and user renames across engines.
- Added bounded cleanup, provisional placement, prepared-label reuse, and late-label/name reuse on later cleanups.
- Shared matching cloud work already in flight without persisting request identities or tab inputs.

### Setup and background work

- Added the first-run Cloud AI, Gemini Nano and Offline setup choice, including preserving configured Ollama.
- Added optional local background preparation and Auto-group new tabs, with cloud new-tab consent and non-incognito boundaries.
- Moved Gemini Nano work into the service worker for popup, toolbar and shortcut flows.
- Added on-device model idle settings, a memory-state indicator and a manual release control.

### Providers and diagnostics

- Added live provider model catalogs, manual model IDs, connection testing beside credentials and stale-response protection.
- Added model-aware reasoning options, strict supported response schemas and bounded Gemini output budgets.
- Added OpenAI Priority selection, optional Cloud economy mode and separate reported provider usage totals.
- Counted late/background inference and tests, with independent clear controls and reset guards.

### Data handling

- Migrated legacy Sync credentials to trusted local storage without overwriting newer or explicitly cleared values.
- Strengthened incognito persistence/sharing boundaries, schema validation and rule import limits.
- Added reset generations for rules, label/name memory, session plans and usage totals.
- Preserved packaged executable code, direct provider requests and sanitised cloud host/path hints.

## Earlier development

The September 2026 1.x source history introduced site-category grouping, provider/reasoning controls, the current popup/settings design, privacy hardening, store artwork and maintained documentation. See Git history for the individual changes; this section does not assign release dates or claim those commits were published to users.
