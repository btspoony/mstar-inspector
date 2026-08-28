---
version: 0.1.0
name: mstar-inspector Console
description: "Functional ops-console design system for the mstar-inspector dev dashboard (same-Worker /dashboard). High contrast, minimal decoration, placeholder sections must read as not wired up. Light theme only at this level."

colors:
  background-100: "#ffffff"
  background-200: "#f4f4f5"
  gray-1000: "#111111"
  gray-900: "#3d3d3d"
  blue-700: "#0066cc"
  red-700: "#b91c1c"
  amber-700: "#b45309"

typography:
  heading-24:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.01em
  heading-16:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0
  copy-16:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
  copy-14:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: 0

spacing:
  base: 4px
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  6: 24px
  8: 32px
  10: 40px
  16: 64px

rounded:
  sm: 6px
  # LEVEL2_PLACEHOLDER: activate md (12px), lg (16px), full (9999px) when the
  # component library lands. See mstar-design-md completeness-checklist § Level 2.

# LEVEL2_PLACEHOLDER: full 10-step background/gray scales, gray-alpha scale, all
# accent scales (700-1000), label/button typography, button/input component
# tokens. See mstar-design-md completeness-checklist § Level 2.
---

<!-- COMPLETENESS_LEVEL: 1 — last audited 2026-08-28 -->

# mstar-inspector Console

mstar-inspector Console is the design system for the dev dashboard
(`/dashboard`, plan 08 scaffold). It is a **functional ops console**: high
contrast, few decorative elements, state legible through color and copy rather
than ornament. The audience is the operator who deployed the inspector (the
same GitHub user who logs in) — not a marketing surface. UI copy is English.

This is the **light theme**. A dark theme (`DESIGN.dark.md`) is intentionally
not provided at this completeness level.

## Colors

All values live in the frontmatter (`colors:` is the SSOT). Usage rules:

- `background-100` — page surface.
- `background-200` — card / section surface **and the disabled-placeholder
  fill**: a placeholder block reads as inert because its fill is flat gray, its
  text is `gray-900`, and it never uses `blue-700`.
- `gray-1000` — primary text (page title, section titles, logged-in user).
- `gray-900` — secondary text (descriptions, "Not in B0" status lines).
- `blue-700` — the single brand accent: primary action (Login / Sign in with
  GitHub) and links. Never used for disabled or placeholder affordances.
- `red-700` — error only (OAuth failure banner, bad-state notices). Pair with
  an explicit "what happened + what to do next" sentence.
- `amber-700` — warning only (e.g. the read-only "reviews are fail-closed in
  production" note on the Review section). Text on `background-100`.

### State legibility (B0 gate)

| State | Expression |
|-------|------------|
| Logged out | login view; exactly one `blue-700` primary action, no sections |
| Logged in | header with GitHub login + Logout link; sections visible |
| Placeholder disabled | `background-200` fill, `gray-900` text, `aria-disabled="true"`, no `blue-700`, no pointer cursor, no client-side submission |
| Error (OAuth failed) | `red-700` text/border banner on the login view; session cookie never set |

A disabled placeholder must never look like a clickable primary button. There
is no hover/active styling for placeholders at this level.

## Typography

Frontmatter `typography:` is the SSOT. System font stack — no webfonts, no
build step (plan 08 locks zero-build SSR).

- `heading-24` — page title ("Dashboard", login title).
- `heading-16` — the three section titles (GitHub App / Model keys / Review).
- `copy-16` — body text, section descriptions.
- `copy-14` — secondary text: "Not in B0" status lines, muted hints.

Dashboard-flavored numerals: where counts or ids appear later, use tabular
figures (`font-variant-numeric: tabular-nums`). No marketing display sizes.

## Spacing & Layout

Frontmatter `spacing:` is the SSOT (base 4px, 8 active steps).

Rhythm rules:

- Three-step rhythm: within a control (`spacing-2`–`spacing-3`), within a
  section/card (`spacing-4`), between sections (`spacing-8`+). Section
  breathing is always larger than control padding.
- Card padding: `spacing-6` (24px) default; `spacing-4` (16px) compact.
- Page gutter: `spacing-6` side padding; content max-width 960px.

## Breakpoints

| Token | Min width | Layout |
|-------|-----------|--------|
| `sm` | 640px | Single column; sections stack; full-width cards |
| `lg` | 900px | Three equal-weight sections in one row (CSS grid `repeat(3, 1fr)`); below `lg` they stack |

Two breakpoints are deliberate (Level 1): the B0 shell has no navigation,
tables, or forms that would need intermediate widths.

<!-- LEVEL3_PLACEHOLDER: add Elevation (card/popover/modal shadows), Motion
(durations + easing + prefers-reduced-motion), Shapes table, Voice & Content
rules, and the full component library when the dashboard moves past scaffold.
See mstar-design-md completeness-checklist § Level 3. -->
