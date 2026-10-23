# Foldnex project context

Foldnex is a dependency-free Manifest V3 Chrome extension. The runtime source is plain JavaScript with no transpilation step.

## Code and product map

- `manifest.json` declares permissions and entry points, including `tabs`, `tabGroups`, `storage`, host access, commands and the service worker.
- `popup.*` is the primary cleanup surface. `options/` configures engines, rules, diagnostics and behaviour. The product contract is described in `docs/architecture/product.md`.
- `src/grouper.js` changes tabs and groups, including one-window and incognito handling, duplicate handling and assignment validation.
- `src/ai-engine.js` implements optional provider requests using tab titles and sanitised URL hints as input data.
- API keys and bearer tokens are stored in `chrome.storage.local`.
- Site-category grouping, offline smart mode and on-device inference are local paths. Cloud grouping is a user-selected path.
- `docs/architecture/design.md` and the popup and options CSS describe the current visuals. `.impeccable/design.json` is an older dark-palette generated snapshot. Rounded controls use a 10px radius.

## Command references

```sh
npm test
for file in background.js popup.js options/options.js src/*.js; do
  node --check "$file"
done
git diff --check
npm run package:store
```

`package:store` creates the Chrome Web Store archive. Loading the unpacked extension in Chrome exercises popup, settings, shortcut, duplicate-removal and grouping behaviour beyond syntax and provider-connection checks.

## Documentation map

`README.md`, `CHANGELOG.md`, `docs/user-guide.md`, `docs/architecture/product.md`, `docs/legal/privacy.md`, `docs/legal/terms.md` and `docs/development/chromewebstore.md` describe permissions and provider behaviour. `store-assets/manifest.json` records screenshot provenance. Original captures and promotional assets are separate from the runtime archive.

[NEXT-RELEASE-URLS.md](NEXT-RELEASE-URLS.md) records the planned move to product sites at `https://magrathean.uk/solutions/<slug>/` and support addresses at `contact+<slug>@magrathean.uk`.
