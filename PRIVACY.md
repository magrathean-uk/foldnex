# Foldnex privacy policy

Effective date: 21 September 2026

Foldnex is a Chrome extension that removes exact duplicate tabs and organises tabs in the current Chrome window. This policy describes the data handled by version 1.0.0.

## Data Foldnex handles

Foldnex reads the URLs and titles of tabs in the current window so it can identify exact duplicates and create useful tab groups. It does not use content scripts, read page bodies, collect form entries, or access Chrome browsing history outside the current window.

Foldnex stores the following data in Chrome extension storage:

- API keys or bearer tokens that the user supplies for an optional cloud provider. These remain in `chrome.storage.local` and are not synced by Foldnex.
- Provider choices, model IDs, grouping preferences, and other non-secret settings. Chrome may sync non-secret preferences when Chrome Sync is enabled.
- User-authored URL rules and exact, content-addressed grouping results. Cached grouping results contain title and sanitised URL fingerprints, group names, and Chrome group colours. They expire after six hours and no more than twelve results are retained.
- Up to twenty recent diagnostic records containing aggregate information such as engine, group count, duplicate count, latency, token usage, and quality flags. Diagnostics do not retain tab titles, URLs, prompts, or provider responses.

Incognito runs do not write rules, cached results, diagnostics, rename preferences, or settings.

## Local and cloud processing

By site category, Offline smart mode, and Chrome Gemini Nano process grouping locally and do not send tab titles or URL hints to a cloud model.

When the user selects By task with a cloud provider, Foldnex sends the selected provider:

- complete tab titles, limited to 1,000 characters each; and
- URL host/path hints.

Credentials embedded in URLs, query strings, and fragments are removed before prompting. Page bodies are never sent. If a cloud provider is selected in an incognito window, this same transmission occurs for that run even though Foldnex does not persist the result.

Supported cloud endpoints are Google Gemini, OpenAI, xAI, Groq, OpenRouter, DeepSeek, and Cerebras. OpenRouter may route a request to the model provider selected by the user. Provider model discovery and connection tests send only the supplied credential and the minimal provider-specific request; they do not send the current tab set. Local Ollama requests use `http://localhost:11434` and do not leave the device.

Foldnex does not operate a backend service. It does not sell personal data, use tab data for advertising, perform analytics, or share data except with a cloud provider the user explicitly selects to perform grouping.

The Donate link opens `https://magrathean.uk/donate/` only after the user selects it. Foldnex does not collect, store, or process donation or payment information; activity on that website is governed by the website's own terms and privacy policy.

## Chrome permissions

- `tabs` lets Foldnex read and manage tabs in the current window, remove exact duplicates, and preserve pinned or internal tabs.
- `tabGroups` lets Foldnex create, name, colour, collapse, and remove Chrome tab groups.
- `storage` stores settings, user rules, short-lived exact results, and aggregate diagnostics.
- Provider host access is used only for the optional provider selected by the user, model discovery, or a user-requested connection test. The localhost host is used only for optional local Ollama.

## Retention and deletion

Cached grouping results expire after six hours. Aggregate diagnostics retain at most twenty runs. Users can clear rules and memory from Foldnex settings, remove provider credentials by clearing their fields, or remove all extension data by uninstalling Foldnex.

## Security

Cloud provider requests use HTTPS. Secrets are kept in extension-local storage and are available only to trusted extension pages. No method of storage is guaranteed to be completely secure, so users should use provider keys with the least privileges and limits appropriate to their account.

## Changes and contact

Material changes will be reflected in this file and its effective date. Questions or privacy requests can be submitted through the [Foldnex issue tracker](https://github.com/magrathean-uk/foldnex/issues).
