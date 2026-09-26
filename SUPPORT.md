# Foldnex support

For setup and everyday use, start with the [README](README.md). Report reproducible bugs and feature requests through [GitHub issues](https://github.com/magrathean-uk/foldnex/issues). The existing product contact is [contact+foldnex@magrathean.uk](mailto:contact+foldnex@magrathean.uk).

## Include enough detail to reproduce

Provide your Chrome version, operating system, Foldnex version from `chrome://extensions`, grouping strategy, and selected engine. Describe what you expected, what happened, and whether the popup, toolbar, or keyboard shortcut started the run. Use a small synthetic set of tab titles and URLs where possible.

Do not attach credentials, a real tab export, private titles or paths, or full provider responses. Last-run diagnostics can help identify the engine and fallback class, but review anything you share first.

## Common checks

- If a change is not visible, reload Foldnex at `chrome://extensions` and reopen its popup or options page.
- For a local baseline, choose **By site category** or **Offline smart mode**. These grouping paths need no cloud credentials.
- If a cloud engine falls back, check its saved credentials and model, then use **Test connection**. This test uses synthetic tabs; follow it with a real grouping check only when you intend to send that window's titles and URL hints.
- Chrome Gemini Nano depends on Chrome exposing the Prompt API in the extension context. Keep the popup open for an on-device run. Background runs can fall back offline.
- Shortcut assignments can be reviewed at `chrome://extensions/shortcuts`.
- **Ungroup all** removes groups. It does not restore tabs closed during duplicate cleanup.

For data handling, see [Privacy](PRIVACY.md). For sensitive security reports, see [Security](SECURITY.md). No response-time commitment or supported-release schedule is published here.
