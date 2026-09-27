# Chrome Web Store submission

This file contains proposed store metadata, privacy answers, permission justifications, reviewer instructions, and packaging steps. Check them against the package being submitted. It does not establish that a listing is live or a submission has been accepted.

## Proposed listing

- **Product name:** Foldnex - Tab Organizer
- **Category:** Productivity
- **Language:** English
- **Price:** Free
- **Visibility:** Public
- **Homepage:** https://magrathean.uk/apps/foldnex/
- **Support:** contact+foldnex@magrathean.uk / https://github.com/magrathean-uk/foldnex/issues
- **Privacy policy:** https://magrathean.uk/apps/foldnex/privacy/
- **Terms of service:** https://magrathean.uk/apps/foldnex/terms/

### Summary

Remove exact duplicate tabs and organize the current window into clear groups using local or optional cloud engines.

### Detailed description

Foldnex cleans up the current Chrome window in one action.

- Removes conservative, exact-page duplicates with priority for a pinned survivor, then the active tab, then the leftmost copy.
- Groups tabs by task using Offline smart mode, Chrome Gemini Nano when available, local Ollama, or an optional cloud provider.
- Groups locally by site category when you want deterministic groups such as Socials, Email, AI, Code, and Video.
- Keeps X, Reddit, Slack, and similar services in Socials instead of system or administration groups.
- Supports explicit URL rules, short-lived exact-result reuse, and keyboard shortcuts.
- Includes Offline smart mode and By site category with no API key and no cloud tab-data request.

Cloud grouping is opt-in. When selected, the chosen provider receives tab titles (up to 1,000 characters each) and URL host/path hints. URL credentials, query strings, fragments, and page bodies are not included in grouping inputs. Provider authentication credentials are sent to the provider; titles and paths can still contain sensitive text. See the privacy policy for the complete data contract.

The popup and settings page include a user-initiated Donate link to `https://magrathean.uk/donate/`. It opens in a separate tab. The extension does not process payment information.

## Store assets

- Store icon: `store-assets/store-icon-128.png`
- Screenshots (upload in this order):
  1. `store-assets/screenshots/01-clean-and-group.png`
  2. `store-assets/screenshots/02-engine-choice.png`
  3. `store-assets/screenshots/03-provider-configuration.png`
  4. `store-assets/screenshots/04-rules-and-memory.png`
  5. `store-assets/screenshots/05-behaviour-and-report.png`
- Small promotional tile: `store-assets/small-promo-440x280.png`
- Marquee promotional tile: `store-assets/marquee-promo-1400x560.png`
- Asset provenance: `store-assets/manifest.json`

## Single purpose

Foldnex has one narrow purpose: remove exact duplicate tabs and organise the remaining tabs in the current Chrome window into Chrome tab groups.

## Permission justifications

- **tabs:** Reads URLs, titles, pin state, active state, and position for tabs in the current window; closes conservative exact duplicates; and supplies the remaining tab IDs for grouping. Foldnex does not request the browsing-history permission or read page bodies.
- **tabGroups:** Creates, names, colours, collapses, and removes Chrome tab groups in the current window.
- **storage:** Stores provider credentials locally, non-secret settings, user-authored URL rules, short-lived exact grouping results, and aggregate diagnostics.

The top-level `commands` manifest entry declares user-visible keyboard shortcuts; it is not a requested permission.

## Host permission justifications

These hosts support provider grouping, model-catalog discovery, and connection tests. A grouping request uses the chosen engine; settings can also contact a provider while configuring or testing it.

- `https://generativelanguage.googleapis.com/*`: Google Gemini models, connection test, and grouping.
- `https://api.openai.com/*`: OpenAI models, connection test, and grouping.
- `https://api.x.ai/*`: xAI models, connection test, and grouping.
- `https://api.groq.com/*`: Groq models, connection test, and grouping.
- `https://openrouter.ai/*`: OpenRouter models, connection test, and grouping.
- `https://api.deepseek.com/*`: DeepSeek models, connection test, and grouping.
- `https://api.cerebras.ai/*`: Cerebras models, connection test, and grouping.
- `http://localhost:11434/*`: optional local Ollama models, connection test, and grouping on the user's device.

## Privacy dashboard answers

### Data usage disclosures

Declare these data types:

- **Web history:** tab URLs from the current window are processed for duplicate detection and grouping.
- **Website content:** current-window tab titles are processed for grouping.
- **Authentication information:** optional API keys or bearer tokens supplied by the user are stored locally and sent only to the selected provider for authentication.

There are no content scripts or page-body reads. Titles, paths, and user-authored rules can still contain sensitive information. Review the current dashboard definitions against these inputs; do not interpret URL sanitisation as removing all personal data.

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

1. Load the extension and open several ordinary tabs, including two copies of the same exact URL, plus X or Reddit.
2. Open Foldnex. Leave **By task** selected and choose **Offline smart mode**, or select **By site category**.
3. Select **Clean up and group**. Confirm one exact duplicate is removed and the remaining tabs form named Chrome tab groups.
4. With **By site category**, confirm X and Reddit are grouped under **Socials**, not System or Admin.
5. Select **Ungroup all** to restore the ungrouped tab strip.
6. Open **Rules and settings** to inspect local/cloud labels, privacy disclosure, rules, diagnostics, and behaviour settings.

Cloud providers are optional and require reviewer-supplied credentials. Chrome Gemini Nano is also optional and depends on Chrome/device eligibility.

## Package and submission checklist

1. Run `npm test` and the syntax checks documented in [Contributing](../../.github/CONTRIBUTING.md).
2. Run `npm run package:store`.
3. Confirm the generated ZIP and SHA-256 file under `dist/`. Inspect the runtime file list in `scripts/package-store.sh`; the script preserves the bundled font licence. ZIP integrity and a checksum do not establish reproducible bytes or browser acceptance.
4. Load the ZIP's extracted contents as an unpacked extension and exercise the reviewer path in a current Chrome release.
5. Verify the store artwork dimensions and listing copy above.
6. In the Chrome Web Store Developer Dashboard, upload the ZIP, complete the Store listing, Privacy, and Distribution tabs, and submit for review.
7. The publisher must complete the developer-account registration, fee, identity or contact verification, and two-step verification required by Google. These account steps cannot be included in the source package.

The existing [Terms](../legal/terms.md) contain legal and distribution statements. Keep their factual descriptions aligned with the submitted package and preserve the licence grants and other legal provisions. See [Licensing](../legal/licensing.md) and [Privacy](../legal/privacy.md).
