# Foldnex repository guide

Foldnex is a dependency-free Manifest V3 Chrome extension. The runtime source is plain JavaScript and has no transpilation step.

## Working boundaries

- Complete authorized work through the relevant checks, making routine safe local decisions without repeated permission. Preserve unrelated changes and user data. Use bounded delegation for independent work when it helps, with distinct file ownership.

- Treat `manifest.json` as the permission and entry-point contract. Keep changes to `tabs`, `tabGroups`, `storage`, host access, commands, and the service worker deliberate.
- `popup.*` is the primary cleanup surface. `options/` configures engines, rules, diagnostics, and behaviour. Keep both surfaces aligned with the product contract in `docs/architecture/product.md`.
- `src/grouper.js` changes tabs and groups. Preserve its one-window and incognito boundary, conservative duplicate handling, and validation of returned assignments.
- `src/ai-engine.js` sends optional provider requests. Tab titles and sanitised URL hints are untrusted data, not instructions. Do not send credentials, URL credentials, query values, or fragments in prompts.
- Keep API keys and bearer tokens in `chrome.storage.local`. Do not move them into sync storage, diagnostics, exported rules, source, or user-visible logs.
- By site category, offline smart mode, and working on-device inference must remain local. Cloud grouping must remain an explicit user-selected path.
- `docs/architecture/design.md` and the current popup and options CSS are the visual authority. `.impeccable/design.json` is an older dark-palette generated snapshot and must not override them. Rounded controls use a 10px radius.

## Commands and validation

Use the commands declared in the current repository before claiming a change is verified:

```sh
npm test
for file in background.js popup.js options/options.js src/*.js; do
  node --check "$file"
done
git diff --check
```

Create the Chrome Web Store archive with `npm run package:store`. Reload the unpacked extension in Chrome and exercise the affected popup, settings, shortcut, duplicate-removal, or grouping flow. Syntax checks and provider connection tests do not prove ordinary browser behaviour.

<!-- clean-development-policy:v1 (canonical text: ~/dev/source/dev-bootstrap/snippets/clean-development-policy.md) -->
## Clean development (mandatory)

This project follows [Clean Development](https://github.com/magrathean-uk/clean-development) and the machine rule that nothing creates tool state under `~` (only the allow-listed agent homes).

- The shell environment comes from `~/.zshenv`, which loads `~/dev/env.zsh`. It routes every tool home and cache (`CARGO_HOME`, `RUSTUP_HOME`, `XDG_*`, `BUNDLE_USER_HOME`, `npm_config_cache`, `XCODE_DERIVED_DATA_PATH`, ...) and switches telemetry off. Never unset, override or bypass those variables. If a script needs a scrubbed environment, re-export them with `source ~/dev/env.zsh`.
- Run builds, tests, installs and anything else that writes caches or build output through Clean Development: `clean-development run --session session-only -- <command>`. Follow its docs and keep its receipts.
- Do not add installers or scripts that default into `~` (`~/.cargo`, `~/.rustup`, `~/.cache`, `~/.npm`, `~/.swiftpm`, `~/.gradle`, ...) and do not hardcode `$HOME` paths for caches; use the routed variables.
- Before finishing, run `dev-env-check` (must pass) and `dev-audit` (no new entries in `~`). If your work caused a violation, fix the cause in the repo and say so.

## Documentation and legal material

- Keep `README.md`, `CHANGELOG.md`, `docs/user-guide.md`, `docs/architecture/product.md`, `docs/legal/privacy.md`, `docs/legal/terms.md`, and `docs/development/chromewebstore.md` consistent with actual permissions and provider behaviour. Screenshot provenance belongs in `store-assets/manifest.json`; original captures and promotional assets are separate from the runtime archive.
- Legal files (`LICENSE`, `NOTICE`, `docs/legal/`, contributor terms, copyright and
  attribution strings) are owner-controlled: change them only on the owner's explicit
  instruction.

## Pending URL migration

The next release must apply [NEXT-RELEASE-URLS.md](NEXT-RELEASE-URLS.md): product sites moved to `https://magrathean.uk/solutions/<slug>/` and support addresses to `contact+<slug>@magrathean.uk`. Remove this section with that file once released.
