# Chrome Web Store submission

This file contains proposed store metadata, privacy answers, permission justifications, reviewer instructions, and packaging steps. Check them against the package being submitted. It does not establish that a listing is live or a submission has been accepted.

## Proposed listing

- **Product name:** Foldnex - Tab Organizer
- **Category:** Productivity
- **Language:** English
- **Price:** Free
- **Visibility:** Public
- **Homepage:** https://magrathean.uk/solutions/foldnex/
- **Support:** contact+foldnex@magrathean.uk / https://github.com/magrathean-uk/foldnex/issues
- **Privacy policy:** https://github.com/magrathean-uk/foldnex/blob/main/docs/legal/privacy.md (or https://magrathean.uk/solutions/foldnex/privacy/ once the website carries the 2.2.0 text)
- **Terms of service:** https://magrathean.uk/solutions/foldnex/terms/

### Summary

Remove exact duplicate tabs and organise the current window into clear groups, on your device or with your own AI key.

### Detailed description

Foldnex removes duplicate tabs and organises the current Chrome window into clear, coloured Chrome tab groups.

- Removes conservative, exact-page duplicates, keeping a pinned copy first, then the active tab, then the leftmost copy.
- Groups tabs by task with Offline smart mode, which runs on your device with a small word table built into Foldnex: no account, no key, nothing sent.
- Or groups by task with a cloud model you choose (Google Gemini, Anthropic Claude, OpenAI, xAI, Groq, OpenRouter, DeepSeek, Cerebras) or your own Ollama server: at most one request per cleanup (Anthropic: one identical repeat without the thinking or effort setting if Anthropic rejects it with HTTP 400), and the model returns named groups that Foldnex checks before applying.
- Reuses an applied plan for an unchanged window, and adds a few new tabs on your device instead of asking again.
- If the model answers late, the local grouping is applied at once and an answer that still matches the window is offered in the popup; it changes your tabs only when you select Apply.
- Groups locally by site category when you want groups such as Socials, Email, AI, Code and Video.
- Starts X, Reddit, Slack and similar services in Socials.
- Supports explicit URL rules, remembers your group names, and has keyboard shortcuts.
- In By task, can file tabs you open into a matching existing group as they load (Auto-group new tabs), on your device, on every engine.
- Choose your engine in the first-run setup card or later in Settings. Cleanup is available before you answer the card.
- The extension is free. Cloud providers may charge for API use, including connection tests. OpenAI Priority processing is on by default and requests OpenAI's priority tier, which can cost more; you can turn it off in Settings.
- Local provider-usage totals show request and token counts, including failed requests, and can be cleared. They are not a bill.

Offline smart mode, By site category and Auto-group send no tab data. With a cloud engine or Ollama, a By task cleanup you run sends at most one request to that engine (for Anthropic, one identical repeat without the thinking or effort setting if Anthropic rejects it with HTTP 400), with each eligible tab's title (up to 160 characters) and a short host/path hint. Tabs matched by your URL rules or recognised as social sites are not sent. Private (Incognito) windows send nothing, whatever engine is selected: By task uses Offline smart mode and By site category stays local. For web addresses the hint drops URL credentials, query strings and fragments and masks long identifiers; page bodies are never included. Titles and paths can still contain sensitive text. In Settings, model lists and Test connection use the key currently typed, including an unsaved one, and send no tab data. Settings opens in a regular window, even from a private window's popup, so its model lists and Test connection are regular-window requests. Nothing is sent in the background. Ollama at a loopback address is the first hop: the request goes to the Ollama server on your device, and that server can itself run cloud models. A remote Ollama server receives the same request. See the privacy policy for the complete data contract.

Version 2.2.0 adds Anthropic Claude as a cloud engine. Foldnex asks Chrome for access to Anthropic's API only when you choose that engine; until you allow it, cleanups with Anthropic run on your device and send nothing. Version 2.1.0 removed Chrome Gemini Nano: users who had chosen it now use Offline smart mode.

The popup and settings page include a user-initiated Donate link to `https://magrathean.uk/donate/`. It opens in a separate tab. The extension does not process payment information.

## Store assets

- Store icon: `store-assets/store-icon-128.png`
- Prepared screenshots (upload these derived images in this order):
  1. `store-assets/screenshots/01-grouping-engines.png`: engine chooser with Anthropic · Claude listed, Offline smart mode selected
  2. `store-assets/screenshots/02-provider-usage.png`: provider request usage (example totals)
  3. `store-assets/screenshots/03-behaviour.png`: Behaviour settings
  4. `store-assets/screenshots/04-rules-and-memory.png`: Rules & memory
  5. `store-assets/screenshots/05-on-device-memory.png`: Ollama configuration and model memory
- Small promotional tile: `store-assets/small-promo-440x280.png`
- Marquee promotional tile: `store-assets/marquee-promo-1400x560.png`
- Asset provenance: `store-assets/manifest.json`

All five screenshots are automated headless captures of the unpacked 2.2.0 extension taken on 25 November 2026, so they show the current Settings copy and 01 lists the Anthropic · Claude engine. 02 shows seeded example usage totals, not recorded traffic. 05 shows a model list answered by a loopback stand-in; no model ran. Source captures are retained in `store-assets/source-captures/`; upload the prepared `screenshots/` images (1280 × 800, RGB, full bleed, following Google's [store-image guidance](https://developer.chrome.com/docs/webstore/images)). Their presence in the repository does not establish that they have been uploaded to the dashboard.

To regenerate the prepared images from the source captures, run the artwork helper with Pillow available:

```sh
python3 scripts/prepare-store-screenshots.py store-assets/source-captures/*.png
```

The five numbered captures sort into the required input order. Pillow is only an artwork-tool dependency; it is not used by the extension runtime. Upload screenshot and listing changes through the Developer Dashboard; the ZIP upload/publish API flow below does not upload images or edit listing metadata.

## Single purpose

Foldnex has one narrow purpose: remove exact duplicate tabs and organise the remaining tabs in the current Chrome window into Chrome tab groups. The optional cloud or Ollama engine only decides those groups, and the optional Auto-group setting only adds newly opened or navigated tabs to existing groups.

## Permission justifications

- **tabs:** Reads URLs, titles, pin state, active state and position of tabs in the current window; closes conservative exact duplicates; and supplies the remaining tab IDs for grouping. Notes tab IDs and address hashes as non-incognito tabs are opened or navigated, to recognise new pages and tabs taken out of a group, and reads the tabs of a regular-window group the user renames. With Auto-group new tabs on, it reads the title and URL of an opened or navigated non-incognito tab and of the grouped tabs in its window, to match it to a group on the device. Foldnex does not request the browsing-history permission or read page bodies.
- **tabGroups:** Creates, names, colours, collapses and removes Chrome tab groups in the current window, watches group renames, and with Auto-group new tabs on adds an opened or navigated tab to an existing group in its window.
- **storage:** Stores provider credentials in trusted local extension storage; preferences, which may sync through Chrome; user URL rules and any legacy rule backup; exact grouping results (fingerprints, 6-hour reuse, at most 12); group-name memory (your renames for 90 days, at most 120 names); rename preferences (up to 100, no age limit); diagnostics (20 records) and content-free provider-usage totals. Session storage holds window plans, late-plan offers and tab and group-title bookkeeping until Chrome restarts or the extension is disabled, reloaded or updated.

The top-level `commands` manifest entry declares user-visible keyboard shortcuts; it is not a requested permission.

## Host permission justifications

These hosts are contacted only when the user runs a By task cleanup with that engine selected (at most one request for the window; for Anthropic one identical repeat without the thinking or effort setting after an HTTP 400 that rejects it), runs Test connection (two synthetic tabs) or when Settings loads the engine's model list (no tab data; with the key currently typed, even before Save). Nothing is sent in the background. Cloud engines always use their provider's own address; a saved override is ignored. Only the Ollama address can differ, and it can use HTTP only on this device (`localhost`, `127.0.0.1` or `[::1]`). A saved address grants no further host permission; the extension does not request unrestricted URL access.

- `https://generativelanguage.googleapis.com/*`: Google Gemini models, connection test, and grouping.
- `https://api.openai.com/*`: OpenAI models, connection test, and grouping.
- `https://api.x.ai/*`: xAI models, connection test, and grouping.
- `https://api.groq.com/*`: Groq models, connection test, and grouping.
- `https://openrouter.ai/*`: OpenRouter models, connection test, and grouping.
- `https://api.deepseek.com/*`: DeepSeek models, connection test, and grouping.
- `https://api.cerebras.ai/*`: Cerebras models, connection test, and grouping.
- `https://api.anthropic.com/*` (**optional host permission**, `optional_host_permissions`; not granted at install): Anthropic Claude models list, connection test, and grouping. Foldnex calls `chrome.permissions.request` for it only on the user's own click or choice in Settings, the popup engine list or the setup card when Anthropic is chosen, saved or tested; Chrome shows its own prompt. Without the grant Foldnex sends nothing to Anthropic and a cleanup runs on the device. It is optional so that existing users see no new install-time warning on update, and users of other engines never grant it.
- `http://localhost:11434/*`: optional Ollama server on the user's device, for its model list, connection test and grouping. That server is the first hop and can itself run cloud models. Cleanup requests carry the model unload setting as Ollama's `keep_alive`.

## Privacy dashboard answers

### Data usage disclosures

Declare these data types:

- **Web history:** tab URLs of the current window are processed for duplicate detection and grouping; with a cloud engine or Ollama, a host/path hint of each sent tab goes to that engine when the user runs a cleanup. Address hashes of opened or navigated tabs are kept in session storage. With Auto-group on, an opened or navigated tab's URL is processed on the device.
- **Website content:** tab titles are processed for grouping; with a cloud engine or Ollama they go to that engine when the user runs a cleanup. Group names, which can contain title words, are stored locally in rules, name memory and diagnostics, and in rule files the user exports.
- **Authentication information:** optional API keys or bearer tokens supplied by the user (Anthropic's in the `x-api-key` header) are stored locally and sent only to the selected engine's own address (or the checked Ollama address), never through a redirect, for cleanups, connection tests and model lists. Settings uses the value currently typed, including an unsaved one.

What is sent and when: at most one request per By task cleanup with a cloud engine or Ollama (Anthropic only: one identical repeat without the thinking or effort setting if Anthropic rejects that setting with HTTP 400), holding a row number, title (control characters removed, at most 160 characters) and host/path hint (for web addresses no credentials, port, query or fragment; long identifiers replaced) for each eligible tab. Tabs matched by a URL rule or the Socials group are not sent. Private (Incognito) windows send nothing, whatever engine is selected: By task uses Offline smart mode and By site category stays local. No request when the window has fewer than two eligible tabs or no free group slot, when a saved result for the unchanged window can be reused, while a request or late answer for it is pending, or when at most 10% of its tabs are new or changed since the last model plan. A failed or discarded request can be retried on a later click. A late reply that still matches the window is stored in session storage and offered; it is applied only by the user. Test connection sends two synthetic tabs. Model lists send no tab data. Offline smart mode, By site category, Auto-group, popup opening, tab events and browser start send nothing. Incognito cleanups reuse and store no results.

What is stored and how it is removed: credentials in `chrome.storage.local` (replaced by clearing the field and saving); preferences, including model IDs and an Ollama address, in `chrome.storage.sync`; rules, exact results, name memory and rename preferences in `chrome.storage.local` (removed by **Clear all rules**; results expire after 6 hours, name memory after 90 days, rename preferences have no age limit); diagnostics (20 records, **Clear run history**); provider-usage totals, including failed requests (**Clear provider usage**); window plans, offers and tab bookkeeping in `chrome.storage.session` (cleared when Chrome restarts or the extension is disabled, reloaded or updated). Fingerprints hash normalised titles and sanitised URLs; raw titles and URLs are not stored in them. Group names and rule patterns are stored as text and can contain meaningful tab context. Uninstalling removes the extension's storage in that Chrome profile; exported rule files and copies held by providers are separate.

The first-run setup choice (`setupChoice`), Priority processing (`openaiPriority`), Auto-group (`autoGroupNewTabs`) and the Ollama unload setting (`modelUnloadAfter`) are preferences and add no data type. The setup card's Cloud choice only checks locally whether a key is saved; it never displays, syncs or sends it. 2.1.0 moves a saved Nano choice to Offline smart mode and tries to delete the stored per-tab labels and the removed Nano and Cloud economy settings when its settings load, retrying a failed removal later.

There are no content scripts or page-body reads. Do not interpret URL sanitisation as removing all personal data.

### Required certifications

Before certifying, verify that the submitted package and actual handling satisfy the current dashboard statements. The intended commitments are:

- data is used only to provide and improve the user-facing tab-organisation feature;
- data is not sold or transferred for advertising, creditworthiness, or unrelated purposes;
- data is not used for personalised advertising;
- the extension has no publisher-operated tab-data relay; optional providers apply their own processing policies; and
- the privacy policy accurately describes local and optional cloud processing.

### Remote code

Answer **No**. Foldnex packages all executable JavaScript in the extension. Network responses are model lists or grouping data parsed as data; they are not executed as code.

## Reviewer instructions

No account or API key is required for the main path.

1. Load the extension in a fresh profile (no rules or renamed groups) and open a small window of ordinary tabs: at least two unpinned tabs besides the duplicates, two copies of the same exact URL, plus X or Reddit.
2. Open Foldnex. The first open shows a setup card, **Choose how Foldnex sorts your tabs**. Choose **Offline smart mode**, which needs no key. The card never blocks **Clean up and group**.
3. Leave **By task** selected, or select **By site category**.
4. Select **Clean up and group**. Confirm one exact duplicate is removed and the remaining tabs form named Chrome tab groups.
5. With **By site category**, confirm X and Reddit are grouped under **Socials**.
6. Select **Ungroup current window** to remove the groups. It does not reopen the closed duplicate or restore the original tab order.
7. Open **Rules and settings** to inspect engines, rules, diagnostics and behaviour settings.

Cloud providers are optional and require reviewer-supplied credentials. Choosing **Cloud AI** in the setup card without a saved key opens Settings at the engine section and keeps the current engine until a key is saved. Entering a key in Settings loads that provider's model list with it. With a key and a compatible model, **Test connection** sends one grouping request for two synthetic tabs; a cleanup on a window with two or more unlocked tabs sends one request (for Anthropic, one identical repeat without the thinking or effort setting if it answers HTTP 400 to that setting), and once that plan has been applied a second cleanup on the unchanged window sends none (see **Provider request usage** in Behaviour). For OpenAI, turning Priority processing off makes the test and cleanups request the default tier. For Anthropic, choosing the engine, **Save** or **Test connection** shows Chrome's prompt for `api.anthropic.com`; declining it leaves cleanups local, with the popup showing **Access needed**.

## Package and submission checklist

1. Run `npm test` and the `node --check` syntax checks documented in [Contributing](../../.github/CONTRIBUTING.md).
2. Run `npm run package:store`.
3. Confirm `dist/foldnex-<manifest-version>.zip` passes ZIP integrity checks and its runtime file list matches `scripts/package-store.sh`, including Foldnex's own `LICENSE` and the font and word-table licences. ZIP integrity does not establish browser acceptance.
4. Load the ZIP's extracted contents as an unpacked extension and exercise the reviewer path in a current Chrome release.
5. Verify the store artwork and listing copy above, and update the listing's description and screenshots in the dashboard.
6. In the Chrome Web Store Developer Dashboard, upload the ZIP, complete the Store listing, Privacy and Distribution tabs, and submit for review.
7. The publisher must complete the developer-account registration, fee, identity or contact verification, and two-step verification required by Google.

### Chrome Web Store API v2 with a service account

The dashboard remains necessary for listing, privacy, distribution and account setup. For an existing item, API v2 can upload a ZIP and submit it for review. Enable the Chrome Web Store API in the Google Cloud project and link the service account to the publisher account in the Developer Dashboard's **Account** settings. Follow Google's [service-account setup](https://developer.chrome.com/docs/webstore/service-accounts) and [API guide](https://developer.chrome.com/docs/webstore/using-api).

Prefer keyless service-account impersonation when available. An authorized identity with the Service Account Token Creator role can obtain an access token with:

```sh
gcloud auth print-access-token \
  --impersonate-service-account=SERVICE_ACCOUNT_EMAIL \
  --scopes=https://www.googleapis.com/auth/chromewebstore
```

Keep the resulting bearer token out of logs, source, screenshots and committed files. If using a service-account key instead, keep it outside the repository in protected credential storage and mint a token with the same scope using Google's authentication libraries. No publisher IDs, service-account identities or credential paths belong in this public guide.

Use `Authorization: Bearer ACCESS_TOKEN` for these requests, replacing the placeholders with the authorized publisher and item identifiers:

1. **Read state:** `GET https://chromewebstore.googleapis.com/v2/publishers/PUBLISHER_ID/items/EXTENSION_ID:fetchStatus`. Confirm access and inspect the current submitted and published state before replacing an upload.
2. **Upload:** `POST https://chromewebstore.googleapis.com/upload/v2/publishers/PUBLISHER_ID/items/EXTENSION_ID:upload`, with `Content-Type: application/zip` and the ZIP's raw bytes as the request body. Follow the [upload reference](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload).
3. **Wait for upload processing:** inspect the upload response's `uploadState`; if it is `UPLOAD_IN_PROGRESS`, poll `fetchStatus` and read `lastAsyncUploadState`, with a bounded timeout. Continue only once the upload state is `SUCCEEDED`, and report any failure rather than submitting an unconfirmed upload.
4. **Submit for review without automatic publication:** `POST https://chromewebstore.googleapis.com/v2/publishers/PUBLISHER_ID/items/EXTENSION_ID:publish`, with `Content-Type: application/json` and body `{"publishType":"STAGED_PUBLISH","skipReview":false,"blockOnWarnings":true}`. `STAGED_PUBLISH` leaves an approved item staged until the publisher publishes it separately; `DEFAULT_PUBLISH` would publish automatically on approval and is not used here. Resolve reported warnings or dashboard blockers. See the [publish reference](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish).
5. **Record the returned state:** `PENDING_REVIEW` means submitted for review; it does not mean approved or live. Use `fetchStatus` and the dashboard to verify review and publication later. Preserve a redacted submission receipt outside the packaged runtime.

The dashboard privacy URL and the Settings link point to the maintained repository policy, which carries the 2.2.0 text once this branch is merged and pushed. The website copies at `https://magrathean.uk/solutions/foldnex/privacy/` and `/terms/` live in the Magrathean site repository and still carry the 2.0.0 text; update them before pointing the dashboard there.

The existing [Terms](../legal/terms.md) contain legal and distribution statements. Keep their factual descriptions aligned with the submitted package and preserve the licence grants and other legal provisions. See [Licensing](../legal/licensing.md) and [Privacy](../legal/privacy.md).
