# Foldnex support

For setup and everyday use, start with the [user guide](../docs/user-guide.md) and [README](../README.md). Report reproducible bugs and feature requests through [GitHub issues](https://github.com/magrathean-uk/foldnex/issues). The product contact is [contact+foldnex@magrathean.uk](mailto:contact+foldnex@magrathean.uk).

## Include enough detail to reproduce

Provide your Chrome version, operating system, Foldnex version from `chrome://extensions`, grouping strategy, and selected engine. Describe what you expected, what happened, and whether the popup, toolbar, or keyboard shortcut started the run. Use a small synthetic set of tab titles and URLs where possible.

Do not attach credentials, a real tab export, private titles or paths, exported private rules, or full provider responses. Last-run diagnostics can help identify the engine and fallback class, but group names may contain sensitive text. Review anything you share first. Specify whether Auto-group or OpenAI Priority is enabled when relevant; never include a credential to reproduce a connection issue.

## Common checks

- If a change is not visible, reload Foldnex at `chrome://extensions` and reopen its popup or options page.
- For a local baseline, choose **By site category** or **Offline smart mode**. These grouping paths need no cloud credentials.
- If a cloud engine falls back, check its saved credentials and model, then use **Test connection**. This test uses synthetic tabs; follow it with a real grouping check only when you intend to send that window's titles and URL hints.
- Foldnex 2.1 removed Chrome Gemini Nano; a saved Nano choice now runs as Offline smart mode.
- Private (Incognito) windows send nothing, whatever engine is selected: By task uses Offline smart mode and By site category stays local.
- Auto-group works in By task on every engine and places tabs locally; it sends nothing. It excludes incognito and respects manually ungrouped tabs until their next navigation. Only tabs opened or navigated after enabling it are eligible.
- **Provider request usage** counts every cleanup and synthetic connection-test request Foldnex starts, including failed and late ones. It is separate from **Last cleanup** and does not calculate provider charges. Use its clear control independently from **Clear run history**.
- Shortcut assignments can be reviewed at `chrome://extensions/shortcuts`.
- **Ungroup current window** removes groups. It does not restore tabs closed during duplicate cleanup.

For data handling, see [Privacy](../docs/legal/privacy.md). For sensitive security reports, see [Security](SECURITY.md). No response-time commitment or supported-release schedule is published here.
