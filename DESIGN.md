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

Foldnex uses an **Instrument Glass** visual language grounded in Magrathean’s current site palette: pale blue working surfaces, deep navy navigation, focused blue actions, violet selection accents, fine blue-grey rules, compact labels, and very restrained elevation. It should feel like a dependable desktop utility rather than an AI dashboard.

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

Use the local system sans-serif stack, matching Magrathean's current site typography without a remote font dependency. Headings are compact and slightly tight. Small instrument labels use uppercase, `11px`, heavy weight, and generous tracking. Ordinary controls and explanatory copy stay in sentence case.

## Layout

The settings page is a centred two-column instrument panel: a compact sticky navigation surface and a flexible content column. Related information sits in shallow bordered panels. Provider choices remain one vertical list; configuration appears in one shared panel below it.

At `920px`, navigation becomes a horizontal strip. At `620px`, forms and controls stack without horizontal page scrolling. The popup is a compact single column with the current-window task first, followed by strategy, memory, toolbar behaviour, and quiet footer links.

## Components

### Buttons

- Primary: blue fill, white label, `10px` radius.
- Secondary: transparent or warm-white fill, grey border, ink label.
- Destructive: pale red surface with red border and label.
- Focus: visible `2px` violet outline with `2px` offset.

### Fields

Inputs and selects use a warm muted fill, visible border, `43px` minimum height, and `10px` radius. Focus changes the border and surface without glow. API keys keep explicit Show/Hide controls.

### Navigation

Inactive items are blue-grey on white. The active item is deep navy with white text and a small violet Material Symbol accent. Navigation items use a `10px` radius.

### Provider list

Providers stay in one vertical radio list with name, one-line description, and a right-aligned Local, Cloud, or status label. Status labels use `10px` corners, never full pills.

### Grouping strategy

Expose **By task** and **By site category** as one compact segmented control. The selected segment is ink black. In the popup, strategy precedes the engine selector and disables the engine while site-category mode is active.

### Toggles

Toggle tracks use `10px` corners. Enabled tracks are action blue; disabled tracks are neutral blue-grey. Keep a strong visible focus state.

## Copy and outcomes

Use direct, sentence-case copy. Lead with the result: groups created, duplicates removed, fallback used, or setup required. Keep technical diagnostics privacy-safe and never show raw titles, URLs, prompts, secrets, or provider response bodies.

## Accessibility and motion

- Interactive controls must expose a visible `:focus-visible` treatment.
- Important controls should meet a `42–44px` target height where the compact popup allows it.
- Motion is functional and brief: `160ms` state transitions and `220ms` panel reveals.
- Engine selection uses one authored compression: provider rows converge into the compact selected-engine control while the chosen configuration surface takes focus. The chooser must remain reversible and keyboard accessible.
- Respect `prefers-reduced-motion`.
