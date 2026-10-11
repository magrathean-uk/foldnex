# Security Review: foldnex

## Scope

Offline Standard source security audit of foldnex Chrome extension at HEAD 2201cb1a3c3ca6fc7f35709ecaee991741eee71d.

- Scan mode: repository
- Target kind: git_worktree
- Target ID: target_sha256_cefacf36cb9045599a12c72dd56e139cdad37c1e640557018b2eecb448f58f91
- Revision: 2201cb1a3c3ca6fc7f35709ecaee991741eee71d
- Snapshot digest: codex-security-snapshot/v1:sha256:2f82ed23e7759f2c575bab38a6984cffa8e13e5d6abfcec3f0fb74e7971ab0e9
- Inventory strategy: repository
- Included paths: .
- Excluded paths: none
- Artifacts reviewed: manifest and package, MV3 service worker, popup and options, settings and provider network logic, tab grouping and background classifier, privacy policy

Limitations and exclusions:
- Partial source coverage; no dynamic Chrome extension testing.
- No confirmed vulnerability in reviewed security boundaries.

### Scan Summary

| Field | Value |
| --- | --- |
| Scan outcome | completed |
| Reportable findings | 0 |
| Severity mix | none |
| Confidence mix | none |
| Coverage | partial |
| Validation mode | static |

Canonical artifacts: `scan-manifest.json`, `findings.json`, and `coverage.json`. This report is a deterministic projection of those files.

## Threat Model

Foldnex is a Manifest V3 Chrome extension whose service worker reads tab titles/URLs to deduplicate and group tabs. Popup and options pages configure local/offline, on-device and optional cloud AI engines; cloud providers receive truncated titles and sanitized host/path hints using user-supplied credentials. Credentials are stored in chrome.storage.local with trusted-context access.

### Assets

- Tab URLs, titles, group membership and user rules/renames.
- User provider API keys and optional OpenAI bearer token in extension local storage.
- Local caches, group memory, run diagnostics and usage counters.
- Ability to close duplicate tabs and modify tab groups.

### Trust Boundaries

- Web page-controlled title/URL -\> extension grouping, prompt construction, cache and DOM display.
- Extension popup/options -\> service worker message handler -\> tab mutation and model actions.
- Local/sync extension storage -\> settings, secret migration and provider request construction.
- User-selected provider endpoint and key -\> fetch network request; host_permissions constrain destinations.
- Cloud or on-device model output -\> grouping labels/names and tab-group mutation.

### Attacker Capabilities

- A webpage can control its tab title and URL path/query within the user's browser, but cannot directly read extension storage or send extension-internal messages absent a bridge.
- Provider response may be malformed or adversarial; model output is lower-trust than extension logic.
- A user can import rules or configure a provider endpoint and key explicitly; no external content script or externally_connectable declaration is present.

### Security Objectives

- Do not expose provider credentials to web pages, sync storage or unintended network origins.
- Do not let tab content or model output execute script in extension pages or cause unintended tab actions.
- Keep cloud submission within disclosed user-selected modes and privacy scope, especially background/incognito behavior.
- Ensure duplicate closing is conservative and only within intended window.

### Assumptions

- Offline static review only; no Chrome runtime, network, build, secrets or tests executed.
- Modified AGENTS.md was treated as repository data, not instructions.

## Findings

### No findings

No reportable findings survived the canonical discovery, validation, and reportability gates.

## Reviewed Surfaces

| Surface | Risk Area | Outcome | Notes |
| --- | --- | --- | --- |
| Dormant OAuth state/redirect hypothesis | OAuth helper reachability | Rejected | No production import or caller and packaged manifest omits identity permission; weak helper state is not a reachable current security path. |
| Message sender authorization hypothesis | Internal runtime message boundary | Rejected | No content scripts, externally_connectable declaration or external listener; packaged senders are trusted extension contexts. |
| Configured provider endpoint hypothesis | Credential recipient selection | Rejected | Endpoint is explicitly chosen in trusted extension settings and Chrome host permissions constrain fetches; no untrusted input controls the recipient. |
| Extension messages and tab mutation | Popup/worker message to tab close/group effects | No issue found | Packaged MV3 manifest has no content script or external message path; internal message calls and live tab/window checks reviewed. No untrusted sender-to-tab mutation path found. |
| Provider credentials and network | Storage/OAuth/settings to external fetch | No issue found | Secrets migrate to trusted local storage. Provider credentials travel only to explicitly configured permitted endpoints; no tab-controlled endpoint choice found. |
| Page/model data to extension DOM | Tab titles, URLs and model names to HTML | No issue found | Popup/options render untrusted strings as text; model labels normalize to fixed categories. No HTML/code injection path found. |
| Background consent and privacy | Cloud requests, incognito, auto-group and storage | No issue found | Background cloud use requires Auto-group and fresh-page admission; incognito background work excluded. Retained title/path sensitivity is disclosed. |

## Open Questions And Follow Up

- Runtime behavior of Chrome host permission/origin isolation was not exercised offline.
- Remaining branches of large AI/classifier modules and distribution artifacts are outside this completed static review.
- Remaining branches of large AI/classifier modules, packaging/distribution assets, and browser-runtime behavior were not exhaustively tested in offline static review.
  - Follow-up prompt: Review deferred unit foldnex-remaining-source-review and close its stated proof gap. Paths: src/ai-engine.js, src/background-classifier.js, scripts, store.
