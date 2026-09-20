---
name: Foldnex
description: Calm, task-first tab organisation for Chrome.
colors:
  page-navy: "#121a2c"
  sidebar-navy: "#0d1424"
  action-ice: "#dbeaf2"
  action-ink: "#102536"
  primary-ink: "#f5f7f8"
  muted-ink: "#b7c3cf"
  quiet-ink: "#9aa9b8"
  focus-blue: "#9fd8ff"
  success-mint: "#8edbb8"
  warning-gold: "#f1ca7a"
  danger-coral: "#ffaaa6"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "clamp(30px, 4vw, 42px)"
    fontWeight: 610
    lineHeight: 1.1
    letterSpacing: "-0.035em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 600
rounded:
  control: "10px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "36px"
components:
  button-primary:
    backgroundColor: "{colors.action-ice}"
    textColor: "{colors.action-ink}"
    rounded: "{rounded.control}"
    padding: "12px 18px"
  input:
    backgroundColor: "rgba(255,255,255,0.035)"
    textColor: "{colors.primary-ink}"
    rounded: "{rounded.control}"
    height: "43px"
  provider-row:
    backgroundColor: "transparent"
    textColor: "{colors.primary-ink}"
    padding: "10px 12px 10px 4px"
    height: "66px"
---

# Design System: Foldnex

## Overview

**Creative North Star: "Quiet Mission Control"**

Foldnex should feel like a focused Magrathean utility: precise, calm, and built for repeated use. Deep navy fields, pale controls, open rows, and thin structural rules keep attention on the tab-cleanup task rather than on the technology behind it.

The interface is compact without feeling cramped. AI is treated as an engine choice, not a visual theme; the product avoids gradients, glowing effects, novelty illustrations, emoji decoration, and card-grid dashboards.

**Key Characteristics:**

- Deep-blue working surfaces with restrained tonal separation.
- A single pale action colour reserved for selection and primary action.
- Open, scannable rows separated by fine rules.
- Direct, sentence-case copy with visible outcomes.

## Colors

The palette pairs cool navy foundations with quiet blue-grey text and one icy action surface. Success, warning, and danger colours appear only as status feedback.

**The One Light Rule.** Use the pale action colour for the current navigation item and the primary action; do not scatter it across decorative accents.

## Typography

**Display Font:** system sans-serif stack

**Body Font:** system sans-serif stack

**Label/Mono Font:** system sans-serif; system monospace only for URLs, shortcuts, and code

**Character:** Native, efficient, and editorially restrained. Hierarchy comes from size, weight, and spacing rather than decorative type.

### Hierarchy

- **Display:** large options-page titles with tight tracking.
- **Headline:** section titles and provider configuration headings.
- **Body:** explanatory copy, kept near 62 characters per line where space allows.
- **Label:** compact control labels and status metadata.

**The Sentence Case Rule.** Keep interface copy in sentence case; reserve uppercase styling for none of the ordinary controls.

## Layout

The options page uses a 248px sticky sidebar and a fluid content column capped near 1120px. Provider choices form one vertical list. At 920px the sidebar becomes a top navigation strip; at 620px controls stack and horizontal padding reduces to 18px. The popup is a fixed, compact single column whose primary task appears before settings and memory.

## Elevation & Depth

The system is flat by default and uses no persistent shadows. Depth comes from tonal surfaces, borders, and state changes. Toasts and selected rows remain visually attached to the same plane.

**The Flat Utility Rule.** Do not add ambient shadows or glass effects; use a one-pixel rule or a subtle surface tint to express structure.

## Shapes

Controls use gently curved 10px corners. Toggles and small status forms may use a full pill. Large containers stay open and rely on dividers instead of nested rounded cards.

## Components

### Buttons

- **Primary:** icy action surface with dark ink and a 10px corner radius.
- **Secondary:** transparent or quiet tonal surface with a fine border.
- **Focus:** a clear 2px blue outline with 3px offset.

### Cards / Containers

- Use open sections and one-pixel dividers.
- Apply a faint surface tint only when grouping related content or indicating selection.
- Avoid stacked card grids for provider choices.

### Inputs / Fields

- Use a quiet translucent surface, a visible fine border, and a 43px minimum height.
- Focus changes the border to focus blue without glow.
- API keys use password fields and explicit Show/Hide text controls.

### Navigation

- Default items are quiet blue-grey; hover raises contrast with a faint surface.
- The active item uses the pale action surface and dark action ink.
- Mobile navigation becomes a horizontally scrollable top strip.

### Provider List

Provider selection is always one vertical radio list. Each row contains the provider name, one short description, and a right-aligned Local or Cloud label; one shared details area follows the list.

The selected row reveals one shared configuration area below the list. Do not duplicate credential, model, base-URL, or test controls across provider-specific cards. Model choices may be refreshed from the provider, but the field remains editable for exact model IDs.

### Grouping Strategy

Expose the two grouping strategies as one compact binary choice: **By task** and **By site category**. In the popup, place the strategy before the task-engine selector and visibly disable the engine while site-category mode is active. In Behaviour settings, use a single segmented radio control inside the existing open settings list; do not introduce a card grid.

State the consequence, not the implementation: By task is title-aware; By site category is local and uses no AI. Site-category examples may clarify the taxonomy (Social for X, Reddit, and Slack; Email for Outlook and Gmail; AI · Assistants for ChatGPT and Grok) without promotional AI language.

### Result and Status Copy

- Use concrete outcomes: groups created, duplicate tabs removed, fallback used, or setup required.
- Keep advanced diagnostics in Behaviour as a quiet definition list: engine, execution source, outcome, aggregate token usage, latency, and quality state. Never show raw titles, URLs, prompts, secrets, or provider response bodies.
- Name the active engine; do not use vague labels such as “AI enabled.”
- Keep Local or Cloud visible beside each engine.
- Error messages should identify the next action without exposing provider responses, credentials, or tab data.

### Accessibility and Motion

- Every interactive control needs a visible `:focus-visible` treatment.
- Controls should meet a 43px minimum target height where the compact surface allows it.
- Maintain text and control contrast on navy surfaces.
- Motion is functional and brief: 160ms state transitions and a 220ms reveal. Disable non-essential animation when `prefers-reduced-motion` is set.
- At 920px the settings sidebar becomes top navigation; at 620px forms and actions stack without horizontal scrolling.

## Do's and Don'ts

### Do:

- **Do** keep cleanup and grouping as the first and strongest action.
- **Do** state concrete results such as groups created and duplicates removed.
- **Do** use thin rules and whitespace to organise dense settings.
- **Do** keep local-versus-cloud status visible in provider selection.

### Don't:

- **Don't** use AI gradients, neon glows, emoji badges, or decorative model artwork.
- **Don't** split providers into separate promotional cards.
- **Don't** hide important outcomes behind generic success language.
- **Don't** introduce shadows where a divider or tonal shift is sufficient.
