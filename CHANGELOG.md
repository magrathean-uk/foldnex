# Changelog

This changelog summarises source changes. A version entry does not establish Chrome Web Store approval or public availability.

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
