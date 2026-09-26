---
version: 1
slug: "popup-html"
primary_target: "popup.html"
related_targets: ["options/options.html"]
---

# Foldnex browser surfaces

## Purpose

The popup helps a Chrome user clean a crowded current window with one decisive action. The options page supports occasional provider, rule, and behaviour management without competing with that action.

## Visual authority

Use [DESIGN.md](../../DESIGN.md) and the current `popup.css` and `options/options.css` as the source of truth. The generated `.impeccable/design.json` records an older dark-palette snapshot and is not visual authority for new work.

## Constraints

- Preserve current controls and provider behaviour.
- Keep the popup compact and make duplicate removal visible in result copy.
- Use the current light, instrument-like design: pale blue page surfaces, white panels, navy copy, blue primary actions, violet focus and selection, fine blue-grey rules, and system typography.
- Every visibly rounded rectangle uses a 10px radius. Do not use full-pill controls.
- Avoid generic AI gradients, glow, emoji decoration, promotional provider cards, and stacked dashboard cards.
- Keep keyboard focus visible, respect reduced motion, and keep local-versus-cloud status understandable.

## Layout and outcomes

Place the current-window task first. A concise header leads to the cleanup action, followed by the strategy, engine or local state, memory summary, and quiet settings link. Use thin rules and shallow bordered surfaces to organise information. Provider choices remain one vertical list in settings with a shared configuration panel.

State results directly: groups created, duplicates removed, fallback used, or setup required. Do not expose raw titles, URLs, prompts, credentials, or provider response bodies in the surface.

## Verification

Inspect the changed surfaces in Chrome, including narrow options layouts, keyboard access, and reduced motion. A static preview cannot establish tab-cleanup behaviour. **Ungroup all** does not restore closed duplicate tabs. Treat `design-qa.md` as a historical report and record fresh evidence for changed behaviour. Keep raster-asset provenance with the assets.
