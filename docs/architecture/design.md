---
name: Foldnex
description: A calm filing tray for Chrome tabs, in light and dark.
source: tokens.css
colors:
  light:
    page: "#f4f5f7"
    surface: "#ffffff"
    surface-sunken: "#eef0f3"
    surface-hover: "#f3f5f8"
    ink: "#1b2129"
    muted: "#4c5563"
    quiet: "#5f6875"
    line: "#e2e5ea"
    line-strong: "#cfd4db"
    control-border: "#7f8793"
    accent: "#1c5fd4"
    accent-hover: "#164eb3"
    accent-ink: "#1a56c4"
    accent-soft: "#e8f0fc"
    success: "#1e7148"
    warning: "#8a5300"
    danger: "#b42d26"
  dark:
    page: "#121418"
    surface: "#1a1d23"
    surface-sunken: "#15181d"
    surface-hover: "#22262d"
    ink: "#e8ebef"
    muted: "#b3bac4"
    quiet: "#959daa"
    line: "#2b3038"
    line-strong: "#3a414b"
    control-border: "#69727f"
    accent: "#8ab4f8"
    accent-hover: "#a8c7fa"
    on-accent: "#0f1b2d"
    accent-soft: "#1f2b3d"
    success: "#7dd3a0"
    warning: "#f2b85c"
    danger: "#f28b82"
typography:
  fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
  sizes: { 2xs: 11px, xs: 12px, sm: 13px, md: 14px, lg: 16px, xl: 20px, 2xl: 26px, 3xl: 34px }
  weights: { regular: 400, medium: 500, semibold: 600, bold: 700 }
spacing: { 1: 4px, 2: 8px, 3: 12px, 4: 16px, 5: 20px, 6: 24px, 8: 32px, 10: 40px, 12: 48px }
rounded: { sm: 6px, base: 10px, lg: 14px }
elevation:
  shadow-1: "0 1px 2px rgba(20, 24, 31, .06); none in dark"
  shadow-2: "0 8px 28px rgba(20, 24, 31, .16); toast only"
  shadow-thumb: "0 1px 2px rgba(0, 0, 0, .25); toggle thumb"
motion: { fast: 140ms, base: 200ms, ease: "cubic-bezier(.22, 1, .36, 1)" }
---

# Design system: Foldnex

## Direction

Foldnex files a crowded window into named groups, so the interface is filed too: every set of controls sits in one titled group with a sentence of help, on a quiet graphite page, and one blue is kept for the action that matters on each screen. Colour beyond that comes from Chrome's own tab-group palette (rule badges) and from status (green, amber, red). Nothing is decorative: no gradients, glows, eyebrow labels, all-caps labels or stacked identical cards.

The one prominent element is the popup's cleanup tray: the number of groupable tabs set large, a line on what will happen, and the full-width **Clean up and group** button. Status and the late-plan offer appear inside the tray, where the eye already is.

## Tokens

All values live once in `tokens.css`, linked by both `popup.html` and `options/options.html`; `popup.css` and `options/options.css` only compose them. The base rules both pages share (reset, focus ring, icon font, switch, strategy segments, `.hidden`, `.visually-hidden`) sit in the second half of `tokens.css`, so the pages cannot drift; each sheet keeps only its own layout and size overrides. Light values are the default; `@media (prefers-color-scheme: dark)` redefines the same names. Both pages declare `color-scheme: light dark`, so native controls follow the theme.

- **Colour.** Text uses `ink` (primary), `muted` (secondary) and `quiet` (help and metadata). Every text pair meets WCAG AA (4.5:1) on the surfaces it sits on, in both themes; `control-border` and the toggle track meet 3:1 against the page, the surface and the sunken surface (3.3:1, 3.6:1 and 3.2:1 in light). `accent` is the primary action and selection colour; links use `accent-ink`. Status colours have `-soft` fills and `-line` borders.
- **Type.** System sans-serif only; no font is fetched. Body is 13px in the popup and 14px in Settings. Headings are sentence case: 26px section titles, 16px group titles, 13px field labels. Numbers that change (tab count, totals, latency) use tabular figures.
- **Space.** A 4px step scale. Groups pad 20px by 24px; rows within a group are separated by 16px and a hairline.
- **Shape.** The 10px radius remains the base for controls and inner panels. Outer containers (Settings groups, popup cards) use 14px and small chips, keys and pills 6px, so nested corners stay concentric instead of one radius everywhere. The toggle thumb and the strategy segments use the 6px radius, and the rule colour badge is a dot. Status dots and the spinner are circles. No radius outside 6, 10 and 14px is used.
- **Focus.** Every focusable control has a 2px `focus` outline at a 2px offset. Containers that clip (the engine chooser, the scrolling top tabs under 920px) leave 4px of room so the ring on an edge item is never cut.
- **Elevation.** Borders carry structure. `shadow-1` lifts a group or the selected segment slightly in light; dark uses none. `shadow-2` is for the toast only.

## Hierarchy rules

- One primary (filled blue) action per screen: the popup's **Clean up and group**; in Settings, **Save** on the provider panel and **Add rule** on Rules & memory. The late-plan **Apply** is filled because it is the only action in its strip.
- Secondary actions are outlined (**Test connection**, **Refresh models**, **Import JSON**, **Export JSON**). The popup's **Ungroup current window** is a quiet text button below the primary.
- Destructive clears (**Clear all rules**, **Clear run history**, **Clear provider usage**) sit alone in a group footer, after a hairline, with a sentence on what they remove, in red outline. Per-row **Delete** in the rules table stays neutral until hovered.

## Popup

A 400px column: header (icon, name, settings), the cleanup tray, the first-run setup card when unanswered, **How tabs are sorted** (strategy segmented control, task engine, status badge with a coloured dot, model and data hint), then rule count, last cleanup and **Run from toolbar** in one card, then the footer links.

States: setup (accent-bordered card with two choices; the current one is marked), ready, running (spinner, disabled primary), success (green line with a tick), warning (amber: fallback, late plan pending, nothing changed), error (red), late plan (accent strip with **Apply**), access needed and key missing (badge and hint), site strategy (engine select disabled), empty (no rules, never run).

## Settings

A 224px sidebar (brand, three sections, version and links) beside one reading column of at most 800px. At 920px the sidebar becomes a top bar; at 620px the sections become three equal tabs and every form stacks.

- **Grouping engines.** An **Engine** group holds the selected-engine button; opening it shows two labelled columns, *On this device or your own server* (Offline smart mode, Ollama) and *Cloud providers, with your own API key* (a two-column grid), as one radio group. The help line above it keeps the data qualifiers: an Ollama server may itself run cloud models, cloud engines send page titles and a short site hint only for By task cleanups and never for tabs your rules keep back, and Anthropic also needs Chrome access. The provider panel below uses a label column and a control column: API key with Show and **Test connection**, model with **Refresh models** and a custom ID, reasoning effort, base URL, and for OpenAI priority processing and the bearer token. A failed model listing, such as Anthropic access not yet allowed, shows as an amber line under the model. **Model memory** appears only for Ollama on a loopback address.
- **Rules & memory.** **Add a rule** (pattern, group name, colour, **Add rule** in one row), then **Your rules** with filter, import, export, the table or a dashed empty state, and **Clear all rules** in the footer.
- **Behaviour.** **Grouping** (strategy, Auto-group, Auto-collapse), **Starting a cleanup** (Run from toolbar and keyboard shortcuts), **Last cleanup** and **Provider request usage**, each diagnostics group ending in its clear action.

Toasts appear bottom right in the inverse surface; errors use the danger fill.

## Accessibility and motion

- Every interactive element shows a 2px `focus` outline with a 2px offset on `:focus-visible`; segmented controls and engine tiles draw it on the visible element.
- Targets are at least 40px in Settings and 44px for the popup's primary action and setup choices.
- Motion answers an action: colour transitions 140ms, toggles and reveals 200ms, the engine list opening with a 320ms height change. `prefers-reduced-motion` removes animation and transitions; the spinner stops and shows a static arc.

## Copy

Sentence case, plain verbs, the result first: groups created, duplicates removed, fallback used, access needed. Diagnostics never show titles, URLs, prompts, keys or provider bodies. Statements about what is sent and where keep the wording of the privacy page.

## Reference precedence

This document and `tokens.css` are the current reference. `.impeccable/design.json` is an older generated snapshot and does not override them. Visual acceptance needs fresh captures of the changed surfaces in both themes; [design-qa.md](../development/archive/design-qa.md) is a historical report.
