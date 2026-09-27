# Foldnex Privacy Policy

**Effective date:** 27 September 2026

**Controller:** MAGRATHEAN UK LTD, trading as Magrathean, company number 16955343, registered office 16 Caledonian Court, West Street, Watford, England, WD17 1RY.

**Privacy contact:** contact+foldnex@magrathean.uk

**Online version:** [https://magrathean.uk/apps/foldnex/privacy/](https://magrathean.uk/apps/foldnex/privacy/)

This Privacy Policy explains how MAGRATHEAN UK LTD ("Magrathean", "we", "us", or "our") processes personal data in connection with the Foldnex Google Chrome Extension (Manifest V3), the product website at [https://magrathean.uk/apps/foldnex/](https://magrathean.uk/apps/foldnex/), and related support channels. It is written for users in the United Kingdom, European Economic Area, Switzerland, and other countries where Foldnex is made available.

---

## 1. Short Version & Core Principle

Foldnex operates on an offline-first, local-first architecture. It removes exact duplicate tabs and organizes tabs in the current Chrome window into clean, colored tab groups.

- **Zero extension telemetry:** The extension contains no analytics SDKs, tracking pixels, or cross-site identifiers.
- **No page body reading:** Foldnex never inspects web page content, DOM trees, keystrokes, form submissions, or cookies. It does not inject content scripts into web pages.
- **No cloud relay:** Magrathean operates no cloud proxy or backend relay for your tab data. Tab titles and URLs never pass through Magrathean servers.
- **Local processing:** Deterministic categorization ("By site category"), Offline smart mode, and Chrome built-in Gemini Nano process tab data on your device. Local Ollama requests are sent to `localhost:11434`; Foldnex does not control any downstream handling configured in the user's Ollama installation. Chrome may separately download its built-in model.
- **Optional BYOK AI:** If you explicitly choose an optional cloud AI engine (OpenAI, Google Gemini, Groq, Cerebras, OpenRouter, DeepSeek, or xAI Grok), your browser connects directly to that provider via HTTPS using your user-supplied API key. URL credentials, all query parameters, and fragments are removed from the URL hint before prompting. Tab titles and retained path segments can still contain sensitive information, so review the current window before using cloud grouping.

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

### 3.1 Tab Metadata (Current Window Only)
- Tab URLs, tab titles (truncated to 1,000 characters for cloud prompts), pin state, active tab status, and tab position.
- Used strictly to identify exact duplicates and assign tabs to Chrome tab groups.
- Does not access browser history outside the current window.

### 3.2 Credentials & Configuration (chrome.storage.local)
- User-supplied API keys or bearer tokens for optional cloud providers. Stored in `chrome.storage.local`, restricted to trusted extension contexts. Chrome extension storage is not encrypted; these values are not placed in Chrome Sync or sent to Magrathean.
- Non-secret preferences (engine selection, model IDs, grouping preferences, collapse settings). These may be synchronized via Chrome Sync if enabled by the user in browser settings.

### 3.3 User-Authored Rules & Grouping Cache
- Domain-classification rules, including user-authored patterns and labels. Exported rule files include that rule content.
- Scoped group-rename preferences containing a fingerprint, a user or generated group label, and a Chrome color token. Group labels can contain meaningful tab context.
- Content-addressed grouping results containing fingerprints of complete titles and sanitised URL inputs, group titles, and Chrome group color tokens. Raw titles and raw URLs are not stored in this cache.
- The cache treats entries older than six hours as ineligible for reuse when it reads or writes the cache. Expired entries are removed during a later cache write, rather than by a guaranteed six-hour deletion timer. New cache writes retain at most twelve entries.

### 3.4 Aggregate Diagnostics
- Up to twenty recent diagnostic records containing technical metadata: engine type, tab count, group count, duplicate count, latency (ms), token metrics, and quality flags.
- Diagnostics strictly exclude tab titles, URLs, prompts, and provider responses.

---

## 4. Incognito Window Isolation

When Foldnex groups tabs in an Incognito window:
- That run does **not** persist custom rules, cached grouping results, diagnostic records, or rename preferences.
- Chrome extension settings in `chrome.storage.local` and `chrome.storage.sync` are shared between regular and Incognito contexts. User changes to these settings can still be saved.
- If an optional cloud provider is selected, direct client-to-provider prompting occurs for that execution, but no cache or record is retained in extension storage.

---

## 5. Data That Leaves Your Device

The extension and its supporting services have these data-handling paths:

1. **User-Selected Cloud AI Provider (BYOK):** When you select "By task" with an optional cloud engine, Foldnex connects directly from your browser to that provider endpoint using your stored API key. Tab titles (up to 1,000 characters each) and a sanitised URL host/path hint are sent. URL credentials, all query parameters, and fragments are removed from the hint, but Foldnex cannot guarantee that a title or retained path segment contains no sensitive information.
2. **Provider Discovery & Connection Tests:** Model discovery sends your API key and a catalog request. "Test connection" sends two synthetic example tabs (`example.com`), your selected model, and your credential through the same grouping request used for real tabs. It does not send your current window's tab data.
3. **Local Ollama:** Requests are addressed to `http://localhost:11434`. Foldnex makes no direct remote request for this engine, but your Ollama configuration may determine how it handles data after receiving the request.
4. **Chrome Sync:** Non-secret preferences saved in Chrome sync storage may be transferred by Chrome when sync is enabled.
5. **Website & Support:** When you visit `https://magrathean.uk/apps/foldnex/` or email `contact+foldnex@magrathean.uk`, standard website technical logs and correspondence are processed as described in the Magrathean Website Privacy Policy.

---

## 6. Chrome Extension Permissions Justification

- **`tabs`:** Required to read tab URLs, titles, pin state, and window position in the active window to detect duplicates and assemble tab groups. Foldnex does not read web page content or browsing history.
- **`tabGroups`:** Required to create, name, assign colors to, collapse, and remove Chrome tab groups in the active window.
- **`storage`:** Required to persist local settings, rules, 6-hour grouping cache, and aggregate diagnostics.
- **Host Permissions:** Restricted to optional cloud AI endpoints (`generativelanguage.googleapis.com`, `api.openai.com`, `api.x.ai`, `api.groq.com`, `openrouter.ai`, `api.deepseek.com`, `api.cerebras.ai`) and `http://localhost:11434`. Contacted solely when you configure and run that provider.

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
- **Manual Clearing:** You can clear rules, grouping memory, and diagnostics at any time from Foldnex Settings.
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
