# Foldnex Privacy Policy

**Effective date:** 25 November 2026 (Foldnex 2.2.0)

**Controller:** MAGRATHEAN UK LTD, trading as Magrathean, company number 16955343, registered office 16 Caledonian Court, West Street, Watford, England, WD17 1RY.

**Privacy contact:** contact+foldnex@magrathean.uk

**Online version:** [https://magrathean.uk/solutions/foldnex/privacy/](https://magrathean.uk/solutions/foldnex/privacy/)

This Privacy Policy explains how MAGRATHEAN UK LTD ("Magrathean", "we", "us", or "our") processes personal data in connection with the Foldnex Google Chrome Extension (Manifest V3), the product website at [https://magrathean.uk/solutions/foldnex/](https://magrathean.uk/solutions/foldnex/), and related support channels. It is written for users in the United Kingdom, European Economic Area, Switzerland, and other countries where Foldnex is made available.

---

## 1. Short Version & Core Principle

Foldnex removes duplicate tabs using conservative page identities and organises the tabs of the current Chrome window into coloured tab groups. Ordinary document anchors are ignored when comparing HTTP(S) URLs; query values and route-like fragments are preserved so different application pages remain distinct.

- **Zero extension telemetry:** The extension contains no analytics SDKs, tracking pixels, or cross-site identifiers.
- **No page body reading:** Foldnex never inspects web page content, DOM trees, keystrokes, form submissions, or cookies. It does not inject content scripts into web pages.
- **No cloud relay:** Magrathean operates no cloud proxy or backend relay for your tab data. Tab titles and URLs never pass through Magrathean servers.
- **Local by default:** Offline smart mode is the default engine. It, "By site category" and "Auto-group new tabs" process tab data on your device and send nothing. Offline smart mode uses tab titles, words from the tab's address and a word table packaged inside the extension; nothing is downloaded or sent to do so.
- **Optional engines you choose:** If you select a cloud engine (Anthropic Claude, OpenAI, Google Gemini, Groq, Cerebras, OpenRouter, DeepSeek, or xAI Grok) or Ollama, and leave the strategy on "By task", a cleanup you run sends **at most one request for the window**, and may send none, directly from your browser with your own API key or bearer token. There is one exception, for Anthropic only: if Anthropic answers HTTP 400 because it does not accept the thinking or effort setting, Foldnex repeats the same request once, with the same rows and key, without that setting (a second request in the same click; it does not repeat after a successful answer, a refusal, a cut-off answer or a timeout). For each eligible tab it holds a row number, the title (control characters removed, whitespace collapsed, at most 160 characters) and a short host/path hint. For web addresses the hint drops URL credentials, port, query and fragment, and replaces long identifiers in the first path segments with `:id` before the hint is shortened. Titles and the remaining path can still contain private information, including an address that appears in a title, so review the window before using a cloud engine.
- **Anthropic needs your permission in Chrome:** Foldnex can reach Anthropic (`api.anthropic.com`) only after you allow it when Chrome asks, which happens when you choose or save Anthropic or run its connection test. Until then a cleanup with Anthropic sends nothing and groups on your device.
- **Rules:** Tabs matched by your URL rules and recognised social sites are grouped locally and not sent.
- **Private windows:** Private (Incognito) windows send nothing, whatever engine is selected: By task uses Offline smart mode and By site category stays local.
- **Settings requests:** In Settings, Foldnex asks the selected provider for its model list, and **Test connection** sends one request with two made-up tabs. Both use the key or token currently typed in the field, including one you have not saved yet. Neither sends your tabs. Settings opens in a regular window, even from a private window's popup, so its model lists and Test connection are regular-window requests.
- **Ollama:** Ollama defaults to `http://localhost:11434`. A loopback address (`localhost`, `127.0.0.1` or `[::1]`) is the first hop: the request goes to the Ollama server on your device, and that server can itself run cloud models, which sends the request off your device. A configured non-loopback Ollama address is treated as cloud processing.
- **No background requests:** Nothing is sent when you open the popup, when tabs open or load, when "Auto-group new tabs" files a tab, or when Chrome starts.

Earlier versions offered Chrome's built-in Gemini Nano model, background labelling and a "Cloud economy" setting. Foldnex 2.1.0 removes them: a saved Gemini Nano choice becomes Offline smart mode, and the extension tries to delete the stored per-tab labels, the Nano timing estimate and the removed settings when its settings next load, retrying a failed removal later. Other records from earlier versions, such as diagnostics and name memory, are kept.

---

## 2. Scope of This Policy

This policy applies to:
- The Foldnex Chrome Extension (Manifest V3);
- The Foldnex website and legal pages at `https://magrathean.uk/solutions/foldnex/`;
- User support, security reports, and communications with Magrathean relating to Foldnex.

Third-party AI providers that you configure (e.g. Anthropic, OpenAI, Google, Groq, Cerebras, OpenRouter, DeepSeek, xAI), the operator of any Ollama or compatible server you configure, and your browser provider (Google) act as independent controllers under their own terms and privacy notices. Links in Foldnex (Donate, Privacy policy, Google AI Studio) open those pages in a new tab only when you click them, under those sites' own policies.

---

## 3. Data Foldnex Handles on Your Device

Foldnex processes the following categories locally within Google Chrome:

### 3.1 Tab Metadata
- Tab URLs, tab titles, pin state, active tab status, tab position and tab-group membership.
- Used to identify exact duplicates, plan groups and assign tabs to Chrome tab groups.
- A cleanup acts on the current window only. To recognise new pages and tabs you take out of a group, Foldnex notes tab IDs and a hash of each tab's address as tabs change in non-Incognito windows, including while "Auto-group new tabs" is off. With "Auto-group new tabs" on, it also reads the title and address of a tab you open, or send to a new page, and the titles and addresses of the tabs in that window's groups, to place it on your device. Foldnex does not access your browsing history.
- When you rename a tab group in a regular window, including a group you created yourself, Foldnex reads that group's tabs to learn the name (see 3.3).

### 3.2 Credentials & Configuration
- User-supplied API keys or bearer tokens for optional cloud providers and an optional Ollama credential. Stored in `chrome.storage.local`, restricted to trusted extension contexts, until you overwrite them or uninstall Foldnex. Chrome extension storage is not encrypted; these values are not placed in Chrome Sync or sent to Magrathean.
- Legacy credentials still present in Chrome Sync are moved to local storage when settings load. An existing local value, including an explicitly cleared one, takes precedence; a missing local credential is saved before its Sync copy is removed. Migration and new credential saves share a lock so a migration cannot replace a newly saved key.
- Preferences: engine, grouping strategy, model IDs, an Ollama address, reasoning choices, OpenAI Priority processing, toolbar, collapse and Auto-group switches, your first-run setup choice and how long a local Ollama model stays loaded. These are kept in Chrome sync storage and may be synchronised by Chrome if you have enabled sync. Model IDs and an Ollama address are stored as you enter them, so do not put private text in them.

### 3.3 Rules, Grouping Memory and Cache (`chrome.storage.local`)
- **URL rules** you add or import: pattern, group name, colour and rule metadata, stored as entered. Patterns are limited to 200 characters; `*` is the only wildcard and other punctuation is literal. Imported rules are validated before storage. Rules from an older format may remain in a local legacy backup until you clear all rules or uninstall the extension. **Export JSON** saves your rules as a browser download; delete that file separately.
- **Rename preferences:** when you rename a tab group in a regular window, a fingerprint of its tabs, the name (up to 40 characters), the colour and an update time. At most 100 are kept, with no age limit.
- **Group-name memory:** the same renames, normalised to at most 30 characters, with fingerprints of the renamed tabs, colours and short grouping keys; they stay usable for 90 days and at most 120 names are kept. Model-chosen names and merge advice saved by earlier versions may remain until this store is next written or cleared; 2.1.0 does not use them.
- **Exact results:** for a window whose tabs have not changed, the finished grouping (fingerprints of each tab, group names, colours and grouping keys) so a repeat cleanup gives the same result without a new request. Entries older than six hours are not reused and at most twelve are kept; expired entries are removed on a later write.
- Fingerprints are hashes of a normalised title (up to 1,000 characters) and a sanitised URL that keeps allowlisted query values. Raw titles and raw URLs are not stored in these records. Hashes support matching; they do not guarantee that meaningful tab context cannot be inferred. Group names and rule patterns are stored as text and can contain words from your titles, addresses or input.
- A reset counter and a schema version. The reset counter stamps grouping memory and pending writes so work begun before you clear memory cannot restore it.

### 3.4 Session Storage (`chrome.storage.session`)
Chrome clears this storage when the browser restarts and when the extension is disabled, reloaded or updated.
- Each window's latest plan: tab and group IDs, group names, colours, grouping keys, update times, hashes of the window's tab set and settings and, for a plan made by a model, short hashes of its tabs, so a few new tabs can be added on your device without a new request.
- A plan offer: when a model's answer arrives after the cleanup has finished, its groups (tab IDs, names, colours, grouping keys), the hash of the tab set it was made for and the tab-group membership at that time. An offer that no longer matches the window is not applied, but can stay stored until it is next checked, replaced, applied or cleared, or the window closes.
- The tab-set hashes cover full addresses, including query and fragment, and titles; the addresses themselves are not stored there.
- For Auto-group: the IDs of new tabs while Auto-group is on, the address hash of each tab taken out of a group (recorded whether or not Auto-group is on), and a start-up marker so restored tabs are not treated as new.
- Group titles and expected-update records that tell your renames apart from Foldnex's own changes.
- Hashes of engine, model and endpoint whose structured-answer format was rejected, so later requests use plain JSON mode (at most 50).

### 3.5 Aggregate Diagnostics
- Up to twenty recent records of cleanups and late-plan applications: engine, the configured model (never the model name a provider returns), effort, strategy, tab, group and duplicate counts, latency, token counts, fallback class and quality flags, and the name and size of each group created. Group names can contain words from tab titles or addresses.
- Diagnostics have no fields for tab titles, URLs, prompts, or provider responses.
- When Foldnex is loaded unpacked for development, it also keeps the latest phase-timing trace of a cleanup (phase names, timings, counts, window IDs, engine and strategy; no titles, URLs, prompts or responses). Other installs, including from the Chrome Web Store, never record this trace.

### 3.6 Provider Request Usage
- Content-free totals in `chrome.storage.local`: overall and per-provider request counts, reported input, output, total and reasoning tokens, cached-input and cache-write tokens, the number of requests without reported usage, returned OpenAI service-tier counts and an update time. They cover the cloud providers and Ollama.
- Every cleanup or connection-test request Foldnex starts counts, including one that fails, times out or answers after the cleanup. Model-list requests do not, and private windows send none. Totals from earlier versions remain until you clear them.
- The totals contain no tab titles, URLs, group names, credentials, prompts, reasoning text or response bodies, and are never sent to Magrathean.

---

## 4. Incognito Window Isolation

When you run a cleanup in an Incognito window:
- Private (Incognito) windows send nothing, whatever engine is selected: By task uses Offline smart mode and By site category stays local.
- Foldnex does not read your URL rules, and does not save the private window's tabs as rules, exact results, group-name memory, rename preferences, window plans, plan offers, diagnostics, provider-usage totals or development traces. It reads shared settings and the reset counter, and keeps private group titles in the service worker's memory while it runs. Social sites are still kept together, locally.
- Incognito tabs are never auto-grouped, and renaming a group in an Incognito window teaches Foldnex nothing.
- Chrome itself keeps the private tabs and their groups. Foldnex writes no group names to the extension's console.
- The popup in an Incognito window can show statistics from regular windows. Chrome extension settings in `chrome.storage.local` and `chrome.storage.sync` are shared between regular and Incognito contexts; settings you change there apply to regular windows too. Settings opens in a regular window, even from a private window's popup, so its model lists and Test connection are regular-window requests.

---

## 5. Data That Leaves Your Device

The extension and its supporting services have these data-handling paths:

1. **Selected cloud engine (bring your own key):** Only when you run a cleanup (popup, toolbar or keyboard shortcut) in a regular window with a cloud engine and "By task". A cleanup sends at most one request for the current window (Anthropic only: a second, identical request without the thinking or effort setting when Anthropic rejects that setting with HTTP 400), directly from your browser to the configured endpoint with your stored credential: an instruction text, the row number, title (up to 160 characters) and host/path hint of each eligible tab not kept back by your rules or the social-site group, the number of groups allowed, the model, answer-format settings, an output-token limit and the model's lowest reasoning setting. Nothing is sent when the window has fewer than two eligible tabs or no free group slot, when a saved result for the unchanged window can be reused, when a request for the window is still pending or its late answer is waiting, or when at most 10% of its tabs are new or changed since the last model plan (Foldnex adds them on your device). A failed or discarded request can be sent again on a later cleanup. Foldnex waits about 5.4 seconds for the answer; a later answer that still matches the window is kept in session storage and offered in the popup, and is applied only if you choose **Apply**. A request is abandoned after 30 seconds.
2. **Recipient and transport:** Requests go directly from Chrome to the endpoint shown in Settings. Cloud engines always use their provider's own address; a saved address override is ignored. An Ollama address must use HTTPS unless it is on your device, and must not contain credentials (any `@`), a query or a fragment; otherwise it is not used and cleanups run locally. Provider requests do not follow redirects. Anthropic requests go only to `https://api.anthropic.com/v1`, carry your key in the `x-api-key` header and include the `anthropic-dangerous-direct-browser-access` header that Anthropic requires for requests from a browser; with some models they also allow Anthropic to answer with another of its models if the first declines (server-side fallback), and the reply is handled the same way. They are sent only after you have allowed Foldnex access to that host in Chrome. OpenRouter requests also identify the application as Foldnex with the public repository address, and OpenRouter can pass the request on to its model hosts under its own terms.
3. **Settings requests:** Settings asks the selected provider for its model list when Settings opens on that provider or you switch to it, when you finish editing its key, token or address, when you select **Refresh models**, after **Save** and after a successful test. It uses the key or token currently in the field, including one you have not saved yet, and sends no tab data. **Test connection** sends one grouping request with two synthetic tabs ("Project plan" and "Project notes" on `example.com`; for Anthropic, one identical repeat without the thinking or effort setting if Anthropic answers HTTP 400 to that setting), using the model, address and credential in the fields; it does not send your window's tabs and can incur provider charges. These requests run whatever strategy or engine your cleanups use. OpenAI Priority processing sends `service_tier: "priority"` when on and `service_tier: "default"` when off; the provider decides the tier it applies.
4. **Configured Ollama:** Cleanups and tests go to your Ollama server in the same way. At a loopback address a cleanup also carries a `keep_alive` value from the "Unload the Ollama model" setting. A loopback address is the first hop: that Ollama server can itself run cloud models, which sends the request off your device. A non-loopback Ollama address is treated as cloud processing. Foldnex does not control how your Ollama installation handles data.
5. **Chrome Sync:** Preferences in Chrome sync storage, including model IDs and an Ollama address, may be transferred by Chrome when sync is enabled.
6. **Website & Support:** When you visit `https://magrathean.uk/solutions/foldnex/` or email `contact+foldnex@magrathean.uk`, standard website technical logs and correspondence are processed as described in the Magrathean Website Privacy Policy.

Offline smart mode, "By site category", "Auto-group new tabs" and every cleanup in a private window send no tab data anywhere. With a cloud engine or Ollama, a failed or late request ends with a local grouping, after the request has been sent.

---

## 6. Chrome Extension Permissions Justification

- **`tabs`:** Reads URLs, titles, pin state, active state and position of tabs in the current window to detect duplicates and build groups; notes tab IDs and address hashes as tabs are opened or navigated, to recognise new pages and tabs taken out of a group; reads the tabs of a regular-window group you rename; and, with "Auto-group new tabs" on, reads the title and address of a newly opened or navigated tab and of its window's grouped tabs. Foldnex does not read web page content or browsing history.
- **`tabGroups`:** Creates, names, colours, collapses and removes Chrome tab groups in the current window, watches group renames, and with "Auto-group new tabs" on adds a new tab to an existing group in its window.
- **`storage`:** Keeps settings, credentials, rules, grouping memory, exact results, session-only window plans, offers and tab bookkeeping, diagnostics and provider-usage totals as described above.
- **Host Permissions:** HTTPS requests to `generativelanguage.googleapis.com`, `api.openai.com`, `api.x.ai`, `api.groq.com`, `openrouter.ai`, `api.deepseek.com` and `api.cerebras.ai`, and HTTP requests to `localhost:11434`. `api.anthropic.com` is an optional host permission: Chrome grants it only when you allow it, and without it Foldnex sends nothing to Anthropic. Choosing another engine does not remove the grant; you can remove it in Chrome's extension details. Saving another Ollama address does not add host permission. A provider is contacted only for a cleanup with that engine, a connection test or a model-list request.

---

## 7. Purposes and Lawful Bases Under UK GDPR

Where Magrathean acts as controller (for support requests, security reports, and website technical logs):
- **Contract Performance (Article 6(1)(b) UK GDPR):** Delivering requested technical support.
- **Legitimate Interests (Article 6(1)(f) UK GDPR):** Securing, troubleshooting, and maintaining the Extension and website.
- **Legal Obligations (Article 6(1)(c) UK GDPR):** Complying with applicable statutory accounting and record-keeping duties.

---

## 8. Data Retention and Deletion

Because tab data is stored locally in your browser, you control its retention:
- **URL rules and the legacy backup:** kept until you delete them or clear all rules. Exported rule files are downloads you delete yourself.
- **Exact results:** not reused after 6 hours; at most 12 kept; expired entries removed on a later write.
- **Name memory:** your renames usable for 90 days, at most 120 names; expired entries removed when that store is next written. Rename preferences: up to 100, no age limit.
- **Diagnostics:** the 20 most recent records, kept until replaced or cleared.
- **Provider usage:** kept until cleared.
- **Session data:** window plans, plan offers, Auto-group records, group-title records and the answer-format list are cleared when Chrome restarts or the extension is disabled, reloaded or updated; a closed window's plan and offer are removed with it.
- **Manual clearing in Settings:** **Clear all rules** removes rules, the legacy rule backup, exact results, group-name memory and rename preferences, and makes stored window plans and offers unusable. **Clear run history** removes cleanup diagnostics; a cleanup still running can add a new record afterwards. **Clear provider usage** resets the request totals; a reply to a request sent before the clear cannot restore them.
- **Credential removal:** clear a credential field and save that provider to replace the stored value with an empty one. For OpenAI, clear both the API key and the bearer token.
- **Complete deletion:** uninstalling Foldnex removes its local and session extension storage from your Chrome profile. Copies held elsewhere (by providers, your Ollama server, Chrome Sync on Google's servers, exported files and support correspondence) are managed separately.

---

## 9. Your Rights Under UK GDPR

Under the UK GDPR and the Data Protection Act 2018, you have the right to request access to, rectification of, or erasure of any personal data we hold about you, to restrict or object to processing, and to data portability. To exercise these rights regarding support correspondence, contact `contact+foldnex@magrathean.uk`.

---

## 10. Complaints

If you are not satisfied with our data handling, you have the right to lodge a complaint with the UK Information Commissioner's Office (ICO) at [ico.org.uk/make-a-complaint](https://ico.org.uk/make-a-complaint). We welcome the opportunity to resolve any concerns directly first.

---

## 11. Changes to This Policy

We may update this Privacy Policy from time to time. The "Effective date" indicates when the current version took effect. Revisions will be published at [https://magrathean.uk/solutions/foldnex/privacy/](https://magrathean.uk/solutions/foldnex/privacy/) and in the project repository.
