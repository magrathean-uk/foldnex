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
- Asks once how you want tabs sorted: Cloud AI with your own API key, Gemini Nano on this device, or Offline with no AI. You can change the engine later in Settings.
- Groups tabs by task using Offline smart mode, Chrome Gemini Nano when available, local Ollama, or an optional cloud provider.
- Groups locally by site category when you want deterministic groups such as Socials, Email, AI, Code, and Video.
- Keeps X, Reddit, Slack, and similar services in Socials instead of system or administration groups.
- Supports explicit URL rules, short-lived exact-result reuse, and keyboard shortcuts.
- Remembers each tab's category and your group names.
- Optional background preparation: with Chrome Gemini Nano or local Ollama, Foldnex can label tabs on your device as they load, so a later cleanup can use saved labels. It is off until you turn it on, choose Gemini Nano during setup, or turn on Auto-group new tabs. Without it, those engines still label the tabs a cleanup placed by address for a later cleanup, then stop.
- While the Gemini Nano model is loaded, Chrome uses about 3 GB of memory, and the first load takes 15-25 seconds. Foldnex releases its model sessions after 5 minutes idle by default, and Chrome then frees the memory itself (about 5 minutes after last use in our measurement). In Settings you can choose right after use, 2, 15 or 60 minutes, or keep it loaded, or release the model at once.
- Can optionally file tabs you open into matching groups as they load (Auto-group new tabs).
- With OpenAI, Priority processing is on by default and sends the priority service tier. Turning it off sends the default tier, including in connection tests; the provider determines its returned tier and billing.
- Optional Cloud economy mode, off by default, skips optional cloud naming and consolidation requests while retaining category labelling and local planning with remembered or deterministic names.
- Matching cloud label and consolidation work can share a request that is already running. Separate local usage totals include inference and connection tests, including late and background replies, and can be cleared independently of cleanup history.
- Includes Offline smart mode and By site category with no API key and no cloud tab-data request.

Background preparation runs only with an on-device engine and never sends tab data to a cloud provider. Cloud grouping is opt-in. When selected, the chosen provider receives tab titles (up to 160 characters each) and URL host/path hints when you run a cleanup. If you also turn on Auto-group new tabs, it receives the same fields for each tab you open or send to a new page afterwards, in the background; tabs that were already open are not sent that way. URL credentials, query strings, fragments, and page bodies are not included in grouping inputs. Provider authentication credentials are sent to the provider; titles and paths can still contain sensitive text. See the privacy policy for the complete data contract.

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

Foldnex has one narrow purpose: remove exact duplicate tabs and organise the remaining tabs in the current Chrome window into Chrome tab groups. Its optional background preparation and optional Auto-group setting serve that same purpose by preparing and extending those groups, and its model unload setting only controls how long the on-device model stays in memory for that work.

## Permission justifications

- **tabs:** Reads URLs, titles, pin state, active state, and position for tabs in the current window; closes conservative exact duplicates; and supplies the remaining tab IDs for grouping. With an on-device engine (Chrome Gemini Nano or local Ollama) and background preparation or Auto-group new tabs on, or with a cloud engine and Auto-group new tabs on, it also reads the titles and URLs of non-incognito tabs in any window as they load to label them ahead of the next cleanup. With an on-device engine it does the same for every open tab after Chrome starts, after Foldnex is installed or updated, and when either setting is turned on; with either setting off, it labels only the tabs a cleanup placed by address, right after that cleanup. Foldnex does not request the browsing-history permission or read page bodies.
- **tabGroups:** Creates, names, colours, collapses, and removes Chrome tab groups in the current window, and with Auto-group new tabs on adds newly opened tabs to a matching group, or creates one, in their window.
- **storage:** Stores provider credentials in trusted local extension storage; non-secret settings, including the first-run setup choice, cloud economy mode, Priority processing, the background-preparation switch and the model unload setting, which may sync through Chrome; user-authored URL rules, short-lived exact grouping results, per-tab category labels (content hashes, 7 days, at most 3,000) and group-name memory (category or hashed keys and names, up to 90 days), aggregate cleanup diagnostics and separate content-free provider-inference usage totals. Session storage holds each non-incognito window's latest plan and Auto-group's new-tab list until Chrome closes.

The top-level `commands` manifest entry declares user-visible keyboard shortcuts; it is not a requested permission.

## Host permission justifications

These hosts support provider grouping, model-catalog discovery, and connection tests. A grouping request uses the chosen engine; settings can also contact a provider while configuring or testing it. With a cloud engine, background labelling contacts that provider only when the user has turned on Auto-group new tabs.

Compatible engines honour a saved base URL and Ollama defaults to the loopback server below. A non-loopback Ollama endpoint is treated as cloud for consent and economy mode, but saving an endpoint does not grant another host permission. Access remains subject to the exact packaged permissions below and Chrome's network rules; the extension does not request unrestricted URL access.

- `https://generativelanguage.googleapis.com/*`: Google Gemini models, connection test, and grouping.
- `https://api.openai.com/*`: OpenAI models, connection test, and grouping.
- `https://api.x.ai/*`: xAI models, connection test, and grouping.
- `https://api.groq.com/*`: Groq models, connection test, and grouping.
- `https://openrouter.ai/*`: OpenRouter models, connection test, and grouping.
- `https://api.deepseek.com/*`: DeepSeek models, connection test, and grouping.
- `https://api.cerebras.ai/*`: Cerebras models, connection test, and grouping.
- `http://localhost:11434/*`: optional local Ollama models, connection test, grouping, and background labelling on the user's device: with background preparation or Auto-group new tabs on, or right after a cleanup for the tabs it placed by address. Label and consolidation requests carry the model unload setting as Ollama's `keep_alive`, which only tells the local server how long to keep its model loaded.

## Privacy dashboard answers

### Data usage disclosures

Declare these data types:

- **Web history:** tab URLs from the current window are processed for duplicate detection and grouping; open tabs' URLs in other windows are processed for optional background labelling.
- **Website content:** tab titles are processed for grouping and optional background labelling.
- **Authentication information:** optional API keys or bearer tokens supplied by the user are stored locally and sent only to the selected provider for authentication.

The first-run setup choice (`setupChoice`), background preparation (`backgroundPrep`) and the model unload setting (`modelUnloadAfter`) add no data type. They are non-secret preferences in Chrome sync storage and hold no tab data. Background preparation changes only when on-device labelling runs, and the unload setting changes only how long the on-device model stays loaded. Neither sends tab data to a cloud provider. The setup card's Cloud choice only checks whether a key is saved in local storage; that check never displays, syncs or sends the key.

Cloud economy mode and Priority processing are also non-secret preferences. Economy is off by default; enabling it skips optional cloud group refinement and naming, while necessary labels and local planning continue. Priority off explicitly sends OpenAI `service_tier: "default"`. Gemini inference requests include an output-token cap scaled by request size and reasoning effort.

The shared settings loader automatically migrates legacy Sync credentials to trusted local storage. It preserves current and explicitly empty local values, removes Sync copies only after successful local persistence where needed, and serializes migration with new secret saves. It does not migrate other preference fields.

Provider usage is stored locally as overall/per-provider request counts, reported input/output/total and reasoning tokens, cached-input/cache-write tokens, counts missing token usage, and returned OpenAI tier counts. Inference and connection tests contribute, including late or background replies; catalog reads and incognito calls do not. The aggregate holds no titles, URLs, group names, prompts, responses or credentials and sends no telemetry. **Clear provider usage** resets it separately from **Clear run history** and grouping memory. Reset generations prevent pre-clear replies or memory writes from restoring cleared data.

Identical active cloud work can be shared in service-worker memory, with no persisted request identity or tab input. Incognito inference does not share it and does not persist grouping memory, learned renames, session group-title baselines, diagnostics or usage totals. User changes to shared settings can still persist. Explicit rule patterns are bounded to 200 characters and use `*` as the only wildcard; imported rule files remain size-limited and schema-validated.

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
2. Open Foldnex. The first open shows a setup card, **Choose how Foldnex sorts your tabs**. Choose **Offline — no AI**, which needs no key or model. The card never blocks **Clean up and group**.
3. Leave **By task** selected (Offline smart mode is now the engine), or select **By site category**.
4. Select **Clean up and group**. Confirm one exact duplicate is removed and the remaining tabs form named Chrome tab groups.
5. With **By site category**, confirm X and Reddit are grouped under **Socials**, not System or Admin.
6. Select **Ungroup current window** to restore the ungrouped tab strip.
7. Open **Rules and settings** to inspect local/cloud labels, privacy disclosure, rules, diagnostics, and behaviour settings.

Cloud providers are optional and require reviewer-supplied credentials. Choosing **Cloud AI** in the setup card without a saved key opens Settings at the engine section and keeps the current engine until a key is saved. Chrome Gemini Nano is also optional and depends on Chrome/device eligibility; the setup card disables it with Chrome's reason when the model is unavailable.

Choosing Gemini Nano in the setup card also turns on background preparation. To inspect it, open **Rules and settings**, then **Grouping engines** with Gemini Nano selected. **Background work and memory** holds **Prepare groups in the background**, **Unload the on-device model** (5 minutes by default), a model-state line, and **Free memory now**. While the model is loaded, Chrome uses about 3 GB of memory. These controls send nothing to a cloud provider. Background preparation needs By task with Chrome Gemini Nano or local Ollama. **Auto-group new tabs** needs By task with one of those or a cloud engine. Neither runs with Offline smart mode or By site category.

With reviewer-supplied cloud credentials, inspect **Cloud economy mode** in engine settings: off is the existing behavior; on uses fewer optional requests with potentially simpler names. Enter a provider key and leave the field to fetch its catalog; confirm the full dropdown can show every returned model and that **Custom model** permits manual entry. **Test connection** sits beside the key and refreshes the catalog after a successful test. Changing credentials or providers during a catalog request must not let an older reply replace the current list. For OpenAI, turn Priority processing off before **Test connection** and check that the test follows that setting. In Behaviour, **Last cleanup** distinguishes cached labels from cloud work and **Provider request usage** accumulates late/background inference separately. Clearing provider usage leaves cleanup history intact, and an already-running reply cannot restore the cleared totals. A controlled test of rule clearing should also confirm that an earlier model result cannot repopulate cleared grouping memory.

## Package and submission checklist

1. Run `npm test` and the syntax checks documented in [Contributing](../../.github/CONTRIBUTING.md).
2. Run `npm run package:store`.
3. Confirm the generated ZIP and SHA-256 file under `dist/`. Inspect the runtime file list in `scripts/package-store.sh`; the script preserves the bundled font licence. ZIP integrity and a checksum do not establish reproducible bytes or browser acceptance.
4. Load the ZIP's extracted contents as an unpacked extension and exercise the reviewer path in a current Chrome release.
5. Verify the store artwork dimensions and listing copy above.
6. In the Chrome Web Store Developer Dashboard, upload the ZIP, complete the Store listing, Privacy, and Distribution tabs, and submit for review.
7. The publisher must complete the developer-account registration, fee, identity or contact verification, and two-step verification required by Google. These account steps cannot be included in the source package.

The existing [Terms](../legal/terms.md) contain legal and distribution statements. Keep their factual descriptions aligned with the submitted package and preserve the licence grants and other legal provisions. See [Licensing](../legal/licensing.md) and [Privacy](../legal/privacy.md).
