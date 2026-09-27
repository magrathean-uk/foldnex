# Contributing to Foldnex

Start with a [bug report or feature request](https://github.com/magrathean-uk/foldnex/issues). Explain the tab-management problem and a small, reproducible example. Use synthetic titles and URLs instead of a real browsing session.

Read [Licensing](../docs/legal/licensing.md) and the existing [Terms](../docs/legal/terms.md) before preparing code changes. The source code is MIT-licensed (see [LICENSE](../LICENSE)); these are working conventions, not a separate contribution licence. Reporting a problem does not require a patch.

## Development

Foldnex is plain JavaScript, HTML, and CSS with a Manifest V3 service worker. There is no compilation step and no package dependency installation is needed for the current scripts. Use Node.js with the built-in test runner and npm for the commands below.

Load the directory containing `manifest.json` through **Load unpacked** at `chrome://extensions`. After a source edit, reload the extension and reopen its popup or options page.

From the repository root:

```sh
npm test
for file in background.js popup.js options/options.js src/*.js; do
  node --check "$file"
done
git diff --check
```

`npm test` maps to `node --test`. Tests in `test/core.test.js` cover URL identity, site grouping, provider request construction, cache scope, fallback behaviour, and incognito persistence using fixtures and mocked browser APIs. They do not establish that a live provider or Chrome feature works on a particular device.

## Validate the changed behaviour

Use a disposable Chrome window with sample tabs when testing cleanup, since the action closes duplicate tabs. Check the actual popup, settings page, shortcut, or toolbar path affected by the change.

- For duplicate handling, cover ordinary anchors, route fragments, different queries, pinned copies, active-tab preference, and tabs navigating during the run.
- For grouping, check complete coverage, explicit URL overrides, tab order, and fallback when the selected engine fails.
- For providers, check the outgoing data boundary and use synthetic tabs for the connection test. A successful connection test is separate from current-window grouping.
- For storage, check secret migration, local versus sync settings, cache invalidation, and incognito behaviour.
- For UI changes, follow [design](../docs/architecture/design.md), check keyboard focus and reduced motion, and inspect both popup and options layouts. Treat [design-qa.md](../docs/development/archive/design-qa.md) as historical evidence.

Keep changes focused. Preserve unrelated work, user data, legal text, and asset attribution. Add a regression test when behaviour changes and an existing fixture can demonstrate it. Describe which checks ran and which browser or provider checks remain unverified.

## Packaging

The release script requires Node.js, Bash, `zip`, `unzip`, and `shasum`:

```sh
npm run package:store
```

It writes `dist/foldnex-<manifest-version>.zip` and its `.sha256` file, replacing outputs with the same version. It packages an explicit runtime file list and tests ZIP integrity. It does not submit the extension or prove browser acceptance. See [Chrome Web Store preparation](../docs/development/chromewebstore.md).

## Reports and proposals

Describe the problem, the resulting behaviour, and the checks performed. Do not include API keys, bearer tokens, exported browsing data, or provider response bodies. Send sensitive findings through [Security](SECURITY.md), not public issues.
