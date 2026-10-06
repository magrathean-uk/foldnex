# Foldnex Privacy Policy

**Effective date:** 6 October 2026

**Controller:** MAGRATHEAN UK LTD, trading as Magrathean, company number 16955343, registered office 16 Caledonian Court, West Street, Watford, England, WD17 1RY.

**Privacy contact:** contact+foldnex@magrathean.uk

**Online version:** [https://magrathean.uk/apps/foldnex/privacy/](https://magrathean.uk/apps/foldnex/privacy/)

This Privacy Policy explains how MAGRATHEAN UK LTD ("Magrathean", "we", "us", or "our") processes personal data in connection with the Foldnex Google Chrome Extension (Manifest V3), the product website at [https://magrathean.uk/apps/foldnex/](https://magrathean.uk/apps/foldnex/), and related support channels. It is written for users in the United Kingdom, European Economic Area, Switzerland, and other countries where Foldnex is made available.

---

## 1. Short Version & Core Principle

Foldnex 2.0 operates on an offline-first, local-first architecture. It removes duplicate tabs using conservative page identities and organizes tabs in the current Chrome window into clean, colored tab groups. Ordinary document anchors are ignored when comparing HTTP(S) URLs; query values and route-like fragments are preserved so different application pages remain distinct.

- **Zero extension telemetry:** The extension contains no analytics SDKs, tracking pixels, or cross-site identifiers.
- **No page body reading:** Foldnex never inspects web page content, DOM trees, keystrokes, form submissions, or cookies. It does not inject content scripts into web pages.
- **No cloud relay:** Magrathean operates no cloud proxy or backend relay for your tab data. Tab titles and URLs never pass through Magrathean servers.
- **Local processing:** Deterministic categorization ("By site category"), Offline smart mode, and Chrome built-in Gemini Nano process tab data on your device. Ollama defaults to `http://localhost:11434`; requests to a loopback address stay on your device, while a configured non-loopback Ollama endpoint is treated as cloud processing. Endpoint access remains subject to Chrome permissions and network rules. Foldnex does not control downstream handling configured in the user's Ollama installation. Chrome may separately download its built-in model. With Gemini Nano or local Ollama selected for "By task", and "Prepare groups in the background" or "Auto-group new tabs" turned on, Foldnex also labels open tabs in all non-Incognito windows in the background, on your device. Background preparation is off until you turn it on in Settings or choose Gemini Nano in the first-run setup card, and it never applies to cloud engines. Without it, an on-device engine only finishes labelling the tabs a cleanup you ran placed by address for a later cleanup, then stops.
- **Optional BYOK AI:** If you explicitly choose an optional cloud AI engine (OpenAI, Google Gemini, Groq, Cerebras, OpenRouter, DeepSeek, or xAI Grok), your browser connects directly to that provider's configured endpoint using your user-supplied API key or bearer token; the packaged provider defaults use HTTPS. A reachable non-loopback Ollama endpoint also receives tab inputs as cloud processing, over that endpoint's transport. This happens when you run a cleanup and, if you turn on "Auto-group new tabs", in the background for each tab you open or send to a new page after turning it on. URL credentials, all query parameters, and fragments are removed from the URL hint before prompting. Tab titles and retained path segments can still contain sensitive information, so review the current window before using cloud grouping.
- **Optional cloud economy mode:** Off by default. When you enable it, Foldnex skips optional cloud group naming and consolidation requests while still obtaining category labels and planning groups locally. It does not enable background cloud processing.

---

## 2. Scope of This Policy

This policy applies to:
- The Foldnex Chrome Extension (Manifest V3);
- The Foldnex website and legal pages at `https://magrathean.uk/apps/foldnex/`;
- User support, security reports, and communications with Magrathean relating to Foldnex.

Third-party AI providers that you configure (e.g. OpenAI, Google, Groq, Cerebras, OpenRouter, DeepSeek, xAI) and your browser provider (Google) act as independent controllers under their own terms and privacy notices.

---

## 3. Data Foldnex Handles on Your Device

Foldnex processes the following categories locally within Google Chrome:

### 3.1 Tab Metadata
- Tab URLs, tab titles (truncated to 160 characters for cloud prompts), pin state, active tab status, and tab position.
- Used strictly to identify exact duplicates, label tabs by category, and assign tabs to Chrome tab groups.
- A cleanup acts on the current window. Background labelling (with Gemini Nano or local Ollama and "Prepare groups in the background" or "Auto-group new tabs" on, or with a cloud engine and "Auto-group new tabs" on) also reads the titles and URLs of tabs in other non-Incognito windows. Foldnex does not access your browsing history.

### 3.2 Credentials & Configuration
- User-supplied API keys or bearer tokens for optional cloud providers and an optional Ollama credential. Stored in `chrome.storage.local`, restricted to trusted extension contexts. Chrome extension storage is not encrypted; these values are not placed in Chrome Sync or sent to Magrathean.
- Legacy credentials already present in Chrome Sync are automatically migrated when settings are loaded. Existing local values, including an explicitly cleared value, take precedence; a missing local credential is saved before its Sync copy is removed. Migration and new credential saves share a lock so a migration cannot replace a newly saved key.
- Non-secret preferences (engine selection, model IDs, provider endpoint settings, grouping preferences, cloud economy mode, OpenAI Priority processing, collapse settings, your first-run setup choice, whether background preparation is on, and how long an idle on-device model stays loaded). These may be synchronized via Chrome Sync if enabled by the user in browser settings.

### 3.3 User-Authored Rules & Grouping Cache
- Domain-classification rules, including user-authored patterns and labels. Exported rule files include that rule content.
- Rule patterns are limited to 200 characters; `*` is the only wildcard and other punctuation is literal. Imported rules are validated before storage. When older learned rules are migrated to the current rule format, their previous contents may remain in a local legacy backup until you clear all rules or uninstall the extension.
- Scoped group-rename preferences containing a fingerprint, a group label, a Chrome color token, and an update time. At most 100 preferences are retained; this store has no automatic age expiry. Group labels can contain meaningful tab context.
- Content-addressed grouping results containing fingerprints of normalized titles (up to 1,000 characters) and sanitised URL inputs, group titles, and Chrome group color tokens. Raw titles and raw URLs are not stored in this cache.
- The cache treats entries older than six hours as ineligible for reuse when it reads or writes the cache. Expired entries are removed during a later cache write, rather than by a guaranteed six-hour deletion timer. New cache writes retain at most twelve entries.
- Per-tab category labels containing, for each labelled tab, a fingerprint of its normalized title (up to 1,000 characters) and sanitised URL input, the category key the engine chose, the engine identifier, a non-secret scope identifier for the model, reasoning setting, endpoint and semantic revision, and the time. Raw titles and raw URLs are not stored. Entries older than seven days are not reused, and at most 3,000 are kept.
- Cache fingerprints can account for allowlisted query values locally, so a change to relevant page context invalidates the result. These values are hashed rather than stored as raw URL data in the grouping caches, and they are excluded from AI prompt URL hints. Hashes support cache matching; they are not a guarantee that meaningful tab context cannot be inferred.
- Group-name memory containing group names chosen by you or by a model, Chrome color tokens, grouping keys (category keys or hashes), short hashes of title words (not the words), and, for your own renames, fingerprints of the renamed tabs; and up to 200 pairs of grouping keys across at most 12 engine/model scopes recording which groups a cloud model merged. Model names and merge advice are reused only within their scope; your own renames remain available across engines. Group names can contain meaningful tab context. In this store, your renames remain eligible for 90 days and model-chosen names and merge advice for 14 days, with at most 120 names.
- A reset counter and an estimate of Gemini Nano's speed (two timing values). The reset counter stamps grouping memory and asynchronous writes so a result from work begun before clearing cannot restore the cleared data.
- In session storage (`chrome.storage.session`), cleared when Chrome closes: each window's latest grouping plan (tab IDs, group names, color tokens, category and grouping keys, and a plan signature), the IDs of tabs opened while "Auto-group new tabs" is on, a hash of the page address of each tab taken out of a group, and tab-group titles and expected-update records used to tell your renames apart from Foldnex's own changes. A session-start marker prevents restored tabs from being treated as new during startup.

### 3.4 Aggregate Diagnostics
- Up to twenty recent diagnostic records containing technical metadata: engine type, tab count, group count, duplicate count, latency (ms), token metrics, and quality flags. Each record also lists the name and size of each group created; group names can contain meaningful tab context.
- Diagnostics strictly exclude tab titles, URLs, prompts, and provider responses.
- When Foldnex is loaded unpacked for development, it also keeps the latest phase-timing trace of a cleanup and of background work (phase names, timings, counts, window IDs, and the engine and strategy used; no titles, URLs, prompts, or responses). Other installs, including from the Chrome Web Store, never record this trace.

### 3.5 Provider Request Usage
- Separate, content-free inference totals in `chrome.storage.local`: overall and per-provider request counts, reported input/output/total and reasoning tokens, cached-input and cache-write tokens, the number of requests without reported usage, returned OpenAI service-tier counts, and an update time. These totals cover supported HTTP providers, including Ollama, rather than Chrome's built-in model.
- Inference and connection-test requests contribute, including late or background replies. Model-catalog requests and Incognito inference do not contribute. These totals are independent of the last-cleanup report, so a cleanup that used cached labels can still record a cloud consolidation request.
- Usage aggregates contain no tab titles, URLs, group names, credentials, prompts, reasoning text or provider response bodies. Only normalized counts and allowed provider/tier identifiers are retained. They remain local until cleared or the extension is uninstalled; Foldnex sends no usage telemetry to Magrathean.
- "Clear provider usage" resets the totals independently of rules and cleanup history. Requests dispatched before that clear cannot restore the cleared totals when they finish.

### 3.6 Temporary Request Sharing
- Matching label inputs and identical consolidation requests under the same provider settings can share work already running in the service worker. The request identities and tab inputs exist only in worker memory while that work runs; they are not persisted or logged. Incognito requests do not share this work with ordinary windows.

---

## 4. Incognito Window Isolation

When Foldnex groups tabs in an Incognito window:
- That run does **not** persist custom rules, cached grouping results, per-tab labels, group-name memory, window plans, session group-title baselines, the Gemini Nano speed estimate, diagnostic records, provider-usage totals or rename preferences. Group updates are checked against their member tabs before a group-title baseline or learned rename is saved.
- Incognito tabs are never labelled in the background or auto-grouped.
- Chrome extension settings in `chrome.storage.local` and `chrome.storage.sync` are shared between regular and Incognito contexts. User changes to these settings can still be saved.
- If an optional cloud provider is selected, direct client-to-provider prompting occurs for that execution, but no cache or record is retained in extension storage.

---

## 5. Data That Leaves Your Device

The extension and its supporting services have these data-handling paths:

1. **User-Selected Cloud AI Provider (BYOK):** When you select "By task" with an optional cloud engine, Foldnex connects directly from your browser to that provider's configured endpoint using your stored API key or bearer token. Tab titles (up to 160 characters each) and a sanitised URL host/path hint are sent. A request to consolidate groups sends up to three of each group's tab titles, shortened to 60 characters, with the group's category and tab count. Cloud economy mode skips this optional request; it does not skip needed category labels. If you turn on "Auto-group new tabs", the same title and hint are sent in the background for each tab you open or send to a new page after turning it on, in any non-Incognito window; tabs that were already open are sent only when you run a cleanup. URL credentials, all query parameters, and fragments are removed from the hint, but Foldnex cannot guarantee that a title or retained path segment contains no sensitive information. A cleanup deadline does not necessarily cancel an ordinary cloud request; late replies can prepare a later cleanup and contribute to local usage totals.
2. **Provider Discovery & Connection Tests:** Model discovery sends a catalog request and your configured credential when required or supplied; it sends no tab data. "Test connection" sends two synthetic example tabs (`example.com`), your selected model, and your credential through the same labelling request used for real tabs. It does not send your current window's tab data. OpenRouter requests also identify the application as Foldnex and include the public repository address. OpenAI Priority processing sends `service_tier: "priority"` when on and `service_tier: "default"` when off, including in the test; the returned tier is determined by the provider. Gemini inference includes an output-token cap that scales with request size and selected reasoning effort, including reasoning in the budget.
3. **Configured Ollama:** The default endpoint is `http://localhost:11434`. Loopback requests stay on your device, including background labelling of open tabs with "Prepare groups in the background" or "Auto-group new tabs" on and a cleanup's follow-up labels. They include a `keep_alive` value controlling how long your Ollama server keeps its model loaded. A configured non-loopback Ollama endpoint is treated as cloud processing: background preparation does not authorize requests to it, and background labelling requires "Auto-group new tabs". Tab inputs are then sent to that server over its configured transport when Chrome permits access. Foldnex does not control downstream handling by either local or remote Ollama.
4. **Chrome Sync:** Non-secret preferences saved in Chrome sync storage may be transferred by Chrome when sync is enabled.
5. **Website & Support:** When you visit `https://magrathean.uk/apps/foldnex/` or email `contact+foldnex@magrathean.uk`, standard website technical logs and correspondence are processed as described in the Magrathean Website Privacy Policy.

---

## 6. Chrome Extension Permissions Justification

- **`tabs`:** Required to read tab URLs, titles, pin state, and window position in the active window to detect duplicates and assemble tab groups, and to read the URLs and titles of tabs in other windows for background labelling and "Auto-group new tabs". Foldnex does not read web page content or browsing history.
- **`tabGroups`:** Required to create, name, assign colors to, collapse, and remove Chrome tab groups in the active window, and, with "Auto-group new tabs" on, to add new tabs to a group, or create one, in their window.
- **`storage`:** Required to persist local settings, rules, 6-hour grouping cache, per-tab labels, group-name memory, session-only window plans, aggregate diagnostics and separate provider-inference usage totals.
- **Host Permissions:** The packaged permissions cover HTTPS requests to `generativelanguage.googleapis.com`, `api.openai.com`, `api.x.ai`, `api.groq.com`, `openrouter.ai`, `api.deepseek.com`, `api.cerebras.ai`, and HTTP requests to `localhost:11434`. Saving another compatible-provider or Ollama base URL does not add host permission; access remains subject to those permissions and Chrome's network rules. Providers are contacted when configured or run, including connection tests and model discovery. A cloud provider can also be contacted for tabs opened or sent to a new page with "Auto-group new tabs" on. Loopback Ollama can be contacted for on-device background preparation or a cleanup's follow-up labels.

---

## 7. Purposes and Lawful Bases Under UK GDPR

Where Magrathean acts as controller (for support requests, security reports, and website technical logs):
- **Contract Performance (Article 6(1)(b) UK GDPR):** Delivering requested technical support.
- **Legitimate Interests (Article 6(1)(f) UK GDPR):** Securing, troubleshooting, and maintaining the Extension and website.
- **Legal Obligations (Article 6(1)(c) UK GDPR):** Complying with applicable statutory accounting and record-keeping duties.

---

## 8. Data Retention and Deletion

Because tab data is stored locally in your browser, you retain complete control over retention:
- **Cache eligibility:** Grouping-cache entries older than 6 hours are not reused. Expired entries are removed when a later cache write occurs, and new writes retain at most 12 entries. Diagnostics retain a rolling maximum of 20 runs.
- **Labels and name memory:** Per-tab labels older than 7 days are not reused and at most 3,000 are kept. In group-name memory, your renames remain eligible for 90 days and model-chosen names and merge advice for 14 days, with at most 120 names. Expired entries are removed when that store is next written. The separate scoped rename-preference store retains up to 100 entries without an age expiry; rules and any legacy rule backup remain until removed or cleared.
- **Session data:** Window plans, the "Auto-group new tabs" list, page-address hashes, tab-group titles, expected-update records, and the startup marker in session storage are cleared when Chrome closes.
- **Manual Clearing:** You can clear rules, grouping memory, diagnostics and provider usage from Foldnex Settings. "Clear all rules" also removes the grouping-result cache, per-tab labels, group-name memory, scoped rename preferences and the legacy rule backup, and invalidates session plans. Invalidated plans may remain in session storage until replaced, removed with their window, or cleared when Chrome closes, but are not reused. Generation guards prevent work begun before clearing from restoring usable old grouping memory. "Clear run history" clears cleanup diagnostics; "Clear provider usage" separately resets inference totals and excludes replies from requests dispatched before that clear.
- **Credential Removal:** Clear an API key field and save that provider to remove the key from `chrome.storage.local`.
- **Complete Deletion:** Uninstalling Foldnex permanently purges all local extension storage from your Chrome profile.

---

## 9. Your Rights Under UK GDPR

Under the UK GDPR and the Data Protection Act 2018, you have the right to request access to, rectification of, or erasure of any personal data we hold about you, to restrict or object to processing, and to data portability. To exercise these rights regarding support correspondence, contact `contact+foldnex@magrathean.uk`.

---

## 10. Complaints

If you are not satisfied with our data handling, you have the right to lodge a complaint with the UK Information Commissioner's Office (ICO) at [ico.org.uk/make-a-complaint](https://ico.org.uk/make-a-complaint). We welcome the opportunity to resolve any concerns directly first.

---

## 11. Changes to This Policy

We may update this Privacy Policy from time to time. The "Effective date" indicates when the current version took effect. Revisions will be published at [https://magrathean.uk/apps/foldnex/privacy/](https://magrathean.uk/apps/foldnex/privacy/) and in the project repository.
