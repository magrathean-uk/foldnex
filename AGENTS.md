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

<!-- clean-development-policy:v2 (canonical text: ~/dev/source/dev-bootstrap/snippets/clean-development-policy.md) -->
## Clean development (mandatory)

This project follows [Clean Development](https://github.com/magrathean-uk/clean-development) and the machine rule that nothing creates tool state under `~` (only the allow-listed agent homes).

- Load `~/dev/machine/env.zsh`; `~/.zshenv` does this for every zsh. Machine storage preferences live in `~/dev/machine/storage.conf`; workspace navigation is in `~/dev/START-HERE.md`.
- New sessions select `/Volumes/4TB/machine/cache` when the configured volume is actually mounted and writable, otherwise `~/dev/machine/cache` for ordinary smaller work. Use routed `DEVCACHE`, `CLEAN_DEVELOPMENT_{ROOT,CACHE_ROOT,BUILD_ROOT,SCRATCH_ROOT}`, `BOLYKI_DEV_LIBS` and `TMPDIR`; builds and scratch are beneath the selected cache. Keep active-session destinations fixed; stop if required storage disappears. Other users configure their own volume and fallback.
- SpecieX, large video/model jobs and VMs require external storage; never use internal fallback. Persistent labs, credentials, installed toolchains, source and final deliverables are not disposable caches.
- All active Git entry points belong under `~/dev/source/`, third-party repositories in `source/third-party/`, websites in `source/magrathean/`, and Teslatlas products/docs in `source/teslatlas-service/`. Do not read, scan, move or edit `~/dev/porn`.
- Preserve routed tool homes/caches, caller overrides and SDK/toolchain choices. Never unset or bypass routing. Scrubbed environments must restore the reviewed routing before cache-writing tools run; preserve intentional hermetic Git/Cargo isolation.
- Run builds, tests, installs and anything else that writes caches or build output through Clean Development: `clean-development run --session session-only -- <command>`. Follow its docs and keep its receipts.
- Do not add installers or scripts that default into `~` (`~/.cargo`, `~/.rustup`, `~/.cache`, `~/.npm`, `~/.swiftpm`, `~/.gradle`, ...) and do not hardcode `$HOME` paths for caches; use the routed variables.
- Before finishing, run `dev-env-check`, `dev-projects-check` and `dev-audit`; require passing environment/project checks and no new home-audit entries compared with the task baseline. Fix violations your work caused.

## Documentation and legal material

- Keep `README.md`, `CHANGELOG.md`, `docs/user-guide.md`, `docs/architecture/product.md`, `docs/legal/privacy.md`, `docs/legal/terms.md`, and `docs/development/chromewebstore.md` consistent with actual permissions and provider behaviour. Screenshot provenance belongs in `store-assets/manifest.json`; original captures and promotional assets are separate from the runtime archive.
- Legal files (`LICENSE`, `NOTICE`, `docs/legal/`, contributor terms, copyright and
  attribution strings) are owner-controlled: change them only on the owner's explicit
  instruction.

## Pending URL migration

The next release must apply [NEXT-RELEASE-URLS.md](NEXT-RELEASE-URLS.md): product sites moved to `https://magrathean.uk/solutions/<slug>/` and support addresses to `contact+<slug>@magrathean.uk`. Remove this section with that file once released.
