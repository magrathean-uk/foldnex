---
name: Foldnex
description: Calm, instrument-like tab organisation for Chrome.
colors:
  page: "#f2f5f5"
  surface: "#ffffff"
  surface-muted: "#eef4f8"
  ink: "#102536"
  muted: "#4d6474"
  quiet: "#5b6f7b"
  line: "#d5dfe6"
  line-strong: "#a8b8c3"
  hover-border: "#7890a1"
  action-blue: "#0b6bcb"
  action-hover: "#0858a8"
  action-soft: "#eaf3ff"
  accent-sky: "#0284c7"
  accent-violet: "#7c3aed"
  selection-soft: "#f1edff"
  violet-soft: "#8db7ff"
  focus-violet: "#7c3aed"
  success-green: "#34745a"
  success-border: "#bfd7cb"
  success-soft: "#eef6f1"
  warning-ochre: "#8a641b"
  warning-border: "#e1d2a9"
  warning-soft: "#faf6e9"
  danger-red: "#b33f35"
  danger-border: "#e2bab4"
  danger-border-hover: "#cf9189"
  danger-soft: "#fff8f6"
  placeholder: "#999b92"
  inverse-muted: "#c7c9c2"
typography:
  fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
  displayWeight: 720
  bodyWeight: 400
  labelWeight: 760
rounded:
  all: "10px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
---

# Design system: Foldnex

## Creative direction

Foldnex uses pale blue working surfaces, deep navy navigation, focused blue actions, violet selection accents, fine blue-grey rules, compact labels, and very restrained elevation. Keep the interface compact and focused on tab cleanup.

The extension icon remains the primary brand asset. Interface icons use a locally bundled subset of Google Material Symbols Rounded. Gradients, glowing effects, novelty illustrations, emoji decoration, and promotional provider cards are out of scope.

## Shape rule

Every visibly rounded rectangle uses a `10px` corner radius. This includes panels, controls, status labels, segmented controls, keyboard hints, toasts, toggle tracks, and toggle handles. Do not use full-pill `999px` radii.

## Colour and hierarchy

- The page uses Magrathean reading blue `#f2f5f5`; panels use white `#ffffff`.
- Deep navy `#102536` is reserved for primary copy and active navigation.
- Blue `#0b6bcb` is reserved for primary actions and enabled toggles.
- Violet `#7c3aed` is reserved for focus and selection accents.
- Muted copy uses `#4d6474`; metadata uses `#5b6f7b`.
- Semantic green, ochre, and red appear only for status feedback.
- Borders carry most of the structure. Shadows are subtle and never used as a decorative effect.

## Typography

Use the local system sans-serif stack, without a remote font dependency. Headings are compact and slightly tight. Small instrument labels use uppercase, `11px`, heavy weight, and generous tracking. Ordinary controls and explanatory copy stay in sentence case.

## Layout

The settings page is a centred two-column instrument panel, at most `1180px` wide: a `216px` sticky navigation surface and a flexible content column, separated by `20px`. Its three sections are **Grouping engines**, **Rules & memory**, and **Behaviour**. Related information sits in shallow bordered panels. The compact selected-engine button expands one vertical provider list; the chosen configuration appears below it. Model memory and cloud request cost appear only for applicable engines.

At `920px`, navigation becomes a horizontal strip. At `620px`, it becomes three equal-width section buttons and forms and controls stack; navigation icons are hidden. The rules table retains its own overflow surface. The popup is a `400px` single column with `16px` outer padding and `12px` gaps. Current-window count and cleanup actions lead, followed by live status, an unanswered setup card, strategy and engine, memory summary, toolbar behaviour, and quiet footer links.

## Components

### Buttons

- Primary: blue fill, white label, `10px` radius.
- Secondary: transparent or pale blue fill, blue-grey border, ink label.
- Destructive: pale red surface with red border and label.
- Focus: visible `2px` violet outline with `2px` offset.

### Fields

Settings inputs and selects use the pale blue `surface-muted` fill, visible border, `43px` minimum height, and `10px` radius; the popup engine select is at least `42px`. Focus changes the border and surface without glow. API keys keep explicit Show/Hide controls. Model choices use native selects with a Custom model field, adjacent **Refresh models**, and an inline status message. **Test connection** stays beside the credential field and becomes a stacked action at narrow widths.

In engine settings, reasoning effort sits immediately below the model field. Show the effective value in the popup; disable the control with a clear explanation when the selected model has no adjustable level.

### Navigation

Inactive items are blue-grey on white. The active item is deep navy with white text and a small violet Material Symbol accent. Navigation items use a `10px` radius.

### Provider list

Providers stay in one vertical radio list with name, one-line description, and a right-aligned Local, Cloud, or status label. The selected-engine button exposes its expanded state; the collapsed list is hidden from focus and accessibility traversal. Status labels use `10px` corners, never full pills. A pending cloud setup shows an inline note when configuration is only being previewed and the saved engine remains active.

### Grouping strategy

Expose **By task** and **By site category** as one compact segmented control. The selected segment uses deep navy `#102536` with white labels and muted inverse explanatory text. In the popup, strategy precedes the engine selector and disables the engine while site-category mode is active. The radio inputs retain keyboard focus with a violet outline on the visible segment.

### Setup and diagnostics

The first-run choices use a bordered vertical list beneath the main action. Keep **Current**, the cloud data disclosure, Nano availability and memory guidance visible within each applicable choice. The main cleanup action remains usable before setup is complete.

Status and toast surfaces announce changes politely. Diagnostics use labelled rows with counts, timing and safe fallback classes; separate **Last cleanup** from **Provider request usage** so cached-label runs can still reveal optional cloud work. Destructive clears have explicit labels and confirmation prompts in Settings.

### Toggles

Toggle tracks use `10px` corners. Enabled tracks are action blue; disabled tracks are neutral blue-grey. Keep a strong visible focus state.

## Copy and outcomes

Use direct, sentence-case copy. Lead with the result: groups created, duplicates removed, fallback used, or setup required. Keep technical diagnostics privacy-safe and never show raw titles, URLs, prompts, secrets, or provider response bodies.

## Accessibility and motion

- Interactive controls must expose a visible `:focus-visible` treatment.
- Important controls should meet a `42–44px` target height where the compact popup allows it.
- Motion is functional and brief: ordinary colour transitions are `160ms`, toggles `180ms`, panel reveals `220ms`, and the provider chooser's collapse uses `360ms` with a `180ms` opacity transition.
- Engine selection uses one authored compression: provider rows converge into the compact selected-engine control while the chosen configuration surface takes focus. The chooser must remain reversible and keyboard accessible.
- Respect `prefers-reduced-motion`.

## Reference precedence

Use this document and the tokens in `popup.css` and `options/options.css` for current UI work. `.impeccable/design.json` is an older generated dark-palette snapshot. Its component examples and narrative are historical and must not override the current light palette. The scoped [surface guidance](../../.impeccable/surfaces/popup-html.md) follows the current design.

Visual and interaction acceptance requires a new browser check for the changed surfaces. [design-qa.md](../development/archive/design-qa.md) retains an earlier report; it is not a current release sign-off.
