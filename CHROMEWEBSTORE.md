# Chrome Web Store submission

This file is the maintained source of truth for Foldnex store metadata, privacy answers, permission justifications, reviewer instructions, and release packaging.

## Listing

- **Product name:** Foldnex - Tab Organizer
- **Category:** Productivity
- **Language:** English
- **Price:** Free
- **Visibility:** Public
- **Homepage:** https://github.com/magrathean-uk/foldnex
- **Support:** https://github.com/magrathean-uk/foldnex/issues
- **Privacy policy:** https://github.com/magrathean-uk/foldnex/blob/main/PRIVACY.md

### Summary

Remove exact duplicate tabs and organize the current window into clear groups using local or optional cloud engines.

### Detailed description

Foldnex cleans up the current Chrome window in one action.

- Removes conservative, exact-page duplicates while preserving pinned and browser-internal tabs.
- Groups tabs by task using a local engine, Chrome Gemini Nano, or an optional cloud provider.
- Groups locally by site category when you want deterministic groups such as Socials, Email, AI, Code, and Video.
- Keeps X, Reddit, Slack, and similar services in Socials instead of system or administration groups.
- Supports explicit URL rules, short-lived exact-result reuse, and keyboard shortcuts.
- Includes Offline smart mode and By site category with no API key and no cloud tab-data request.

Cloud grouping is opt-in. When selected, the chosen provider receives complete tab titles and URL host/path hints. Credentials, query strings, fragments, and page bodies are not sent. See the privacy policy for the complete data contract.

The popup and settings page include a user-initiated Donate link to `https://magrathean.uk/donate/`. It opens in a separate tab. The extension does not process payment information.

## Store assets

- Store icon: `store-assets/store-icon-128.png`
- Screenshot: `store-assets/screenshot-popup-1280x800.png`
- Small promotional tile: `store-assets/small-promo-440x280.png`
- Asset provenance: `store-assets/manifest.json`

## Single purpose

Foldnex has one narrow purpose: remove exact duplicate tabs and organise the remaining tabs in the current Chrome window into Chrome tab groups.

## Permission justifications

- **tabs:** Reads URLs, titles, pin state, active state, and position for tabs in the current window; closes conservative exact duplicates; and supplies the remaining tab IDs for grouping. Foldnex does not request the browsing-history permission or read page bodies.
- **tabGroups:** Creates, names, colours, collapses, and removes Chrome tab groups in the current window.
- **storage:** Stores provider credentials locally, non-secret settings, user-authored URL rules, short-lived exact grouping results, and aggregate diagnostics.

The top-level `commands` manifest entry declares user-visible keyboard shortcuts; it is not a requested permission.

## Host permission justifications

Each cloud host is contacted only when its corresponding optional provider is selected, its model catalog is refreshed, or the user selects Test connection.

- `https://generativelanguage.googleapis.com/*` — Google Gemini models, connection test, and grouping.
- `https://api.openai.com/*` — OpenAI models, connection test, and grouping.
- `https://api.x.ai/*` — xAI models, connection test, and grouping.
- `https://api.groq.com/*` — Groq models, connection test, and grouping.
- `https://openrouter.ai/*` — OpenRouter models, connection test, and grouping.
- `https://api.deepseek.com/*` — DeepSeek models, connection test, and grouping.
- `https://api.cerebras.ai/*` — Cerebras models, connection test, and grouping.
- `http://localhost:11434/*` — optional local Ollama models, connection test, and grouping on the user's device.

## Privacy dashboard answers

### Data usage disclosures

Declare these data types:

- **Web history:** tab URLs from the current window are processed for duplicate detection and grouping.
- **Website content:** current-window tab titles are processed for grouping.
- **Authentication information:** optional API keys or bearer tokens supplied by the user are stored locally and sent only to the selected provider for authentication.

Do not declare page-body collection, personal communications, location, financial information, health information, or user activity analytics; Foldnex does not collect them.

### Required certifications

Certify that:

- data is used only to provide and improve the user-facing tab-organisation feature;
- data is not sold or transferred for advertising, creditworthiness, or unrelated purposes;
- data is not used for personalised advertising;
- humans do not read tab data except when the user deliberately includes it in a support request; and
- the privacy policy accurately describes local and optional cloud processing.

### Remote code

Answer **No**. Foldnex packages all executable JavaScript in the extension. Network responses are model lists or grouping data parsed as data; they are not executed as code.

## Reviewer instructions

No account or API key is required for the main path.

1. Load the extension and open several ordinary tabs, including two copies of the same exact URL, plus X or Reddit.
2. Open Foldnex. Leave **By task** selected and choose **Offline smart mode**, or select **By site category**.
3. Select **Clean up and group**. Confirm one exact duplicate is removed and the remaining tabs form named Chrome tab groups.
4. With **By site category**, confirm X and Reddit are grouped under **Socials**, not System or Admin.
5. Select **Ungroup all** to restore the ungrouped tab strip.
6. Open **Rules and settings** to inspect local/cloud labels, privacy disclosure, rules, diagnostics, and behaviour settings.

Cloud providers are optional and require reviewer-supplied credentials. Chrome Gemini Nano is also optional and depends on Chrome/device eligibility.

## Package and submission checklist

1. Run `npm test` and the syntax checks documented in `README.md`.
2. Run `npm run package:store`.
3. Confirm the generated ZIP and SHA-256 file under `dist/`.
4. Load the ZIP's extracted contents as an unpacked extension and exercise the reviewer path in a current Chrome release.
5. Verify the store artwork dimensions and listing copy above.
6. In the Chrome Web Store Developer Dashboard, upload the ZIP, complete the Store listing, Privacy, and Distribution tabs, and submit for review.
7. The publisher must complete the developer-account registration, fee, identity or contact verification, and two-step verification required by Google. These account steps cannot be included in the source package.
