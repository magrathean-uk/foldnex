# Foldnex support

For setup and everyday use, start with the [user guide](../docs/user-guide.md) and [README](../README.md). Report reproducible bugs and feature requests through [GitHub issues](https://github.com/magrathean-uk/foldnex/issues). The product contact is [contact+foldnex@magrathean.uk](mailto:contact+foldnex@magrathean.uk).

## Include enough detail to reproduce

Provide your Chrome version, operating system, Foldnex version from `chrome://extensions`, grouping strategy, and selected engine. Describe what you expected, what happened, and whether the popup, toolbar, or keyboard shortcut started the run. Use a small synthetic set of tab titles and URLs where possible.

Do not attach credentials, a real tab export, private titles or paths, exported private rules, or full provider responses. Last-run diagnostics can help identify the engine and fallback class, but group names may contain sensitive text. Review anything you share first. Specify whether preparation, Auto-group, Cloud economy mode or OpenAI Priority is enabled when relevant; never include a credential to reproduce a connection issue.

## Common checks

- If a change is not visible, reload Foldnex at `chrome://extensions` and reopen its popup or options page.
- For a local baseline, choose **By site category** or **Offline smart mode**. These grouping paths need no cloud credentials.
- If a cloud engine falls back, check its saved credentials and model, then use **Test connection**. This test uses synthetic tabs; follow it with a real grouping check only when you intend to send that window's titles and URL hints.
- Chrome Gemini Nano depends on Chrome exposing the Prompt API to the extension's service worker and on model availability. An earlier Apple Silicon Mac test measured a 15–25 second cold load; devices and Chrome versions can differ. Cleanup gives an unfinished load a bounded wait, places remaining tabs locally, and prepares on-device labels for a later cleanup. `chrome://on-device-internals` shows Chrome's model state.
- **Free memory now** releases Foldnex's base sessions; a prompt already running can finish on its own clone. Chrome determines when its model memory is freed. Saved labels remain available; queued preparation can load the model again.
- Auto-group requires By task and a supported model engine. It excludes incognito and respects manually ungrouped tabs until their next navigation. With a cloud engine, only tabs opened or navigated after enabling it are eligible; enabling the switch does not submit existing tabs.
- **Provider request usage** includes inference and synthetic connection tests, including late/background replies. It is separate from **Last cleanup** and does not calculate provider charges. Use its clear control independently from **Clear run history**.
- Shortcut assignments can be reviewed at `chrome://extensions/shortcuts`.
- **Ungroup current window** removes groups. It does not restore tabs closed during duplicate cleanup.

For data handling, see [Privacy](../docs/legal/privacy.md). For sensitive security reports, see [Security](SECURITY.md). No response-time commitment or supported-release schedule is published here.
