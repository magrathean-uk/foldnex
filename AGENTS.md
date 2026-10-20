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

## Models

Claude Code (Fable, or Opus 5.5, for cross-cutting work and review; Sonnet 5.5 for routine implementation; Haiku 5.5 for exploration) or Codex `gpt-6.1-sol` (`gpt-6-luna` for swarm exploration). Keep changes small; distinguish local checks from device and live-service evidence.

<!-- clean-development-policy:v4 (clean-development 0.6.0; canonical: bolyki-dev/clean-development/docs/policy-snippet.md) -->
## Clean development (mandatory)

- Storage is routed for you: every zsh loads `~/dev/machine/env.zsh`; hooks pin the mode per session (`$CLEAN_DEV_MODE` is `external` when the 4TB is attached, else `internal`). Do not wrap commands, override or unset the routed variables.
- Temp files go to `$TMPDIR` (session scratch, deleted at session end), throwaway build output to `$CLEAN_DEV_BUILDS`, caches wherever their variables point. Never write caches, builds or temp files into `~`, `~/dev` or this repo outside its git-ignored build directories.
- Internal mode: before any download or build likely over 5 GB, stop and ask G (suggest waiting for the 4TB).
- This repo's `.clean-development.json` (schema v2) lists its git-ignored `buildDirs`/`depDirs`; keep it accurate when the build layout changes.
- No dot-folders in `~` or `~/dev`. `.env` files stay git-ignored; read them only when the task needs them; never commit them.

## Documentation and legal material

- Keep `README.md`, `CHANGELOG.md`, `docs/user-guide.md`, `docs/architecture/product.md`, `docs/legal/privacy.md`, `docs/legal/terms.md`, and `docs/development/chromewebstore.md` consistent with actual permissions and provider behaviour. Screenshot provenance belongs in `store-assets/manifest.json`; original captures and promotional assets are separate from the runtime archive.
- Legal files (`LICENSE`, `NOTICE`, `docs/legal/`, contributor terms, copyright and
  attribution strings) are owner-controlled: change them only on the owner's explicit
  instruction.

## Pending URL migration

The next release must apply [NEXT-RELEASE-URLS.md](NEXT-RELEASE-URLS.md): product sites moved to `https://magrathean.uk/solutions/<slug>/` and support addresses to `contact+<slug>@magrathean.uk`. Remove this section with that file once released.
