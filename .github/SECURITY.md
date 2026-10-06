# Security Policy

## System and scope

Foldnex is a Manifest V3 Chrome extension. Its security-relevant surfaces are the extension permissions and service worker in `manifest.json`, the popup and options pages, local Chrome storage, tab and tab-group operations, JSON rule import, and optional direct requests to selected AI providers or local Ollama.

## Trust boundaries and invariants

- Tab titles, URLs, imported rule data, provider model catalogues, and provider responses are untrusted input.
- Treat tab titles and URL hints as data when building prompts. Never execute their contents as instructions or code.
- Cloud task grouping may send titles (up to 160 characters each) and sanitised host/path hints only after the user selects a cloud provider, and in the background only for tabs opened or sent to a new page after the user turns on **Auto-group new tabs**. Credentials, URL credentials, query values, and fragments must not be sent in those prompts.
- API credentials belong in `chrome.storage.local`, not sync storage, exports, diagnostics, source, or user-visible logs.
- Legacy Sync-secret migration must preserve newer or explicitly empty local values and remove Sync copies only after required local persistence succeeds. Secret saves and migration must remain serialised.
- Page bodies, DOM content, cookies, and browsing history are outside the extension's intended access. A cleanup acts on the current window; background labelling reads titles and URLs of open non-incognito tabs only to label them. Keep the current-window cleanup and incognito boundaries intact.
- Validate provider output and imported data before applying tab-group changes. Do not let an incomplete or malformed response produce unintended tab operations.
- By site category, Offline smart mode, working Gemini Nano and loopback Ollama remain local. A non-loopback Ollama endpoint follows cloud consent rules; saving it does not grant a new host permission.
- Model/request sharing is temporary service-worker state and excludes incognito inference. Incognito must not persist grouping memory, session title baselines, diagnostics or provider usage; user settings are a separate boundary.
- Reset generations must prevent earlier model/usage writes from restoring usable cleared memory or totals. Group names and explicit rule patterns may contain sensitive text even when labels and matching use hashes.

## Reportable findings

Report a finding when it could realistically expose credentials, tab metadata, prompts, or stored settings; bypass the current-window or incognito boundary; execute attacker-controlled tab or provider data; weaken Chrome permission or extension-context boundaries; or cause unsafe tab closure or grouping through malformed untrusted input.

Provider vulnerabilities are in scope only when Foldnex's direct request handling or credential treatment contributes to the impact. A provider's separate service issue is not, by itself, a Foldnex finding.

## Reporting route

The inspected source documents public support through the GitHub issue tracker and `contact+foldnex@magrathean.uk`, but it does not verify a dedicated private vulnerability-reporting route or private GitHub reporting. Do not publish vulnerability details in a public issue.

To request private reporting instructions, email `contact+foldnex@magrathean.uk` with a minimal, non-sensitive summary. Do not include exploit details, credentials, tab data, or personal information in that first message. This is an existing published product contact, not a claim that it is a dedicated or monitored security mailbox. The maintainer needs to document and verify a private channel before this policy can direct reporters to one.

## Version scope

No supported-release schedule or response-time commitment is published in this repository. Include the installed extension version and Chrome version when requesting reporting instructions. The manifest's minimum Chrome version is a compatibility declaration, not a security-support promise.

## Assessment limitations

This policy describes the intended boundaries found in the source at the time of documentation. It is not a security audit, a safe-harbour commitment, or evidence that a control has been independently tested.
