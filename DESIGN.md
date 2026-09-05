---
version: 0.2.0
name: mstar-inspector Console
description: "Functional ops-console design system for the mstar-inspector developer dashboard. High contrast, minimal decoration, state through color + copy. Dark is the default theme; light follows prefers-color-scheme until the navbar theme toggle stores a manual choice (localStorage mstar.dashboard.theme, light|dark) — the stored choice wins over the OS. Supersedes the plan-29 lock (2026-09-04, user instruction, iteration 013)."

# Runtime default = dark. Top-level colors: matches themes.dark.colors so
# {colors.X} component refs resolve to the console default. Light values
# (including the original L1 hexes) live under themes.light.colors.
defaultTheme: dark
themeMechanism: "manual data-theme override (navbar toggle), prefers-color-scheme fallback"

colors:
  # Background surfaces
  background-100: "#09090b"
  background-200: "#18181b"
  background-300: "#27272a"

  # Gray solid (100 lightest fill → 1000 primary text on this theme)
  gray-100: "#18181b"
  gray-200: "#1f1f23"
  gray-300: "#27272a"
  gray-400: "#3f3f46"
  gray-500: "#52525b"
  gray-600: "#71717a"
  gray-700: "#8b8b94"
  gray-800: "#d4d4d8"
  gray-900: "#b0b0b8"
  gray-1000: "#f4f4f5"

  # Gray alpha (translucent overlays / borders / dividers)
  gray-alpha-100: "#ffffff12"
  gray-alpha-200: "#ffffff17"
  gray-alpha-300: "#ffffff21"
  gray-alpha-400: "#ffffff2e"
  gray-alpha-500: "#ffffff3d"
  gray-alpha-600: "#ffffff5c"
  gray-alpha-700: "#ffffff8a"
  gray-alpha-800: "#ffffffa3"
  gray-alpha-900: "#ffffffc4"
  gray-alpha-1000: "#ffffffe8"

  # Blue — links, focus, primary actions
  blue-100: "#0c1a2e"
  blue-200: "#0f2744"
  blue-300: "#163a5f"
  blue-400: "#1e4d7a"
  blue-500: "#2563a8"
  blue-600: "#3b82f6"
  blue-700: "#4ea1ff"
  blue-800: "#7ab8ff"
  blue-900: "#93c5fd"
  blue-1000: "#dbeafe"

  # Red — errors, destructive actions
  red-100: "#2a1215"
  red-200: "#3b1219"
  red-300: "#4c1d24"
  red-400: "#7f1d1d"
  red-500: "#991b1b"
  red-600: "#dc2626"
  red-700: "#f87171"
  red-800: "#fca5a5"
  red-900: "#fecaca"
  red-1000: "#fee2e2"

  # Amber — warnings
  amber-100: "#27190a"
  amber-200: "#3b250c"
  amber-300: "#4c2f0c"
  amber-400: "#78350f"
  amber-500: "#92400e"
  amber-600: "#d97706"
  amber-700: "#fbbf24"
  amber-800: "#fcd34d"
  amber-900: "#fde68a"
  amber-1000: "#fef3c7"

  # Green — success
  green-100: "#052e16"
  green-200: "#0a3d1e"
  green-300: "#14532d"
  green-400: "#166534"
  green-500: "#15803d"
  green-600: "#22c55e"
  green-700: "#4ade80"
  green-800: "#86efac"
  green-900: "#bbf7d0"
  green-1000: "#dcfce7"

  # Teal
  teal-100: "#042f2e"
  teal-200: "#0a3d3b"
  teal-300: "#115e59"
  teal-400: "#0f766e"
  teal-500: "#0d9488"
  teal-600: "#14b8a6"
  teal-700: "#2dd4bf"
  teal-800: "#5eead4"
  teal-900: "#99f6e4"
  teal-1000: "#ccfbf1"

  # Purple
  purple-100: "#2e1065"
  purple-200: "#3b0764"
  purple-300: "#4c1d95"
  purple-400: "#6b21a8"
  purple-500: "#7e22ce"
  purple-600: "#9333ea"
  purple-700: "#c084fc"
  purple-800: "#d8b4fe"
  purple-900: "#e9d5ff"
  purple-1000: "#f3e8ff"

  # Pink
  pink-100: "#500724"
  pink-200: "#6b0f31"
  pink-300: "#9d174d"
  pink-400: "#9d174d"
  pink-500: "#be185d"
  pink-600: "#db2777"
  pink-700: "#f472b6"
  pink-800: "#f9a8d4"
  pink-900: "#fbcfe8"
  pink-1000: "#fce7f3"

themes:
  default: dark
  mechanism: "manual data-theme override (navbar toggle), prefers-color-scheme fallback"
  # Manual theme contract (plan 41): the navbar toggle stores light|dark in
  # localStorage["mstar.dashboard.theme"] and applies documentElement[data-theme]
  # before first paint; a stored choice wins over prefers-color-scheme, unset
  # follows the OS (dark console default when the OS expresses neither).
  # Supersedes the plan-29 lock (2026-09-04, user instruction, iteration 013).
  dark:
    colors:
      # Background surfaces
      background-100: "#09090b"
      background-200: "#18181b"
      background-300: "#27272a"

      # Gray solid (100 lightest fill → 1000 primary text on this theme)
      gray-100: "#18181b"
      gray-200: "#1f1f23"
      gray-300: "#27272a"
      gray-400: "#3f3f46"
      gray-500: "#52525b"
      gray-600: "#71717a"
      gray-700: "#8b8b94"
      gray-800: "#d4d4d8"
      gray-900: "#b0b0b8"
      gray-1000: "#f4f4f5"

      # Gray alpha (translucent overlays / borders / dividers)
      gray-alpha-100: "#ffffff12"
      gray-alpha-200: "#ffffff17"
      gray-alpha-300: "#ffffff21"
      gray-alpha-400: "#ffffff2e"
      gray-alpha-500: "#ffffff3d"
      gray-alpha-600: "#ffffff5c"
      gray-alpha-700: "#ffffff8a"
      gray-alpha-800: "#ffffffa3"
      gray-alpha-900: "#ffffffc4"
      gray-alpha-1000: "#ffffffe8"

      # Blue — links, focus, primary actions
      blue-100: "#0c1a2e"
      blue-200: "#0f2744"
      blue-300: "#163a5f"
      blue-400: "#1e4d7a"
      blue-500: "#2563a8"
      blue-600: "#3b82f6"
      blue-700: "#4ea1ff"
      blue-800: "#7ab8ff"
      blue-900: "#93c5fd"
      blue-1000: "#dbeafe"

      # Red — errors, destructive actions
      red-100: "#2a1215"
      red-200: "#3b1219"
      red-300: "#4c1d24"
      red-400: "#7f1d1d"
      red-500: "#991b1b"
      red-600: "#dc2626"
      red-700: "#f87171"
      red-800: "#fca5a5"
      red-900: "#fecaca"
      red-1000: "#fee2e2"

      # Amber — warnings
      amber-100: "#27190a"
      amber-200: "#3b250c"
      amber-300: "#4c2f0c"
      amber-400: "#78350f"
      amber-500: "#92400e"
      amber-600: "#d97706"
      amber-700: "#fbbf24"
      amber-800: "#fcd34d"
      amber-900: "#fde68a"
      amber-1000: "#fef3c7"

      # Green — success
      green-100: "#052e16"
      green-200: "#0a3d1e"
      green-300: "#14532d"
      green-400: "#166534"
      green-500: "#15803d"
      green-600: "#22c55e"
      green-700: "#4ade80"
      green-800: "#86efac"
      green-900: "#bbf7d0"
      green-1000: "#dcfce7"

      # Teal
      teal-100: "#042f2e"
      teal-200: "#0a3d3b"
      teal-300: "#115e59"
      teal-400: "#0f766e"
      teal-500: "#0d9488"
      teal-600: "#14b8a6"
      teal-700: "#2dd4bf"
      teal-800: "#5eead4"
      teal-900: "#99f6e4"
      teal-1000: "#ccfbf1"

      # Purple
      purple-100: "#2e1065"
      purple-200: "#3b0764"
      purple-300: "#4c1d95"
      purple-400: "#6b21a8"
      purple-500: "#7e22ce"
      purple-600: "#9333ea"
      purple-700: "#c084fc"
      purple-800: "#d8b4fe"
      purple-900: "#e9d5ff"
      purple-1000: "#f3e8ff"

      # Pink
      pink-100: "#500724"
      pink-200: "#6b0f31"
      pink-300: "#9d174d"
      pink-400: "#9d174d"
      pink-500: "#be185d"
      pink-600: "#db2777"
      pink-700: "#f472b6"
      pink-800: "#f9a8d4"
      pink-900: "#fbcfe8"
      pink-1000: "#fce7f3"
  light:
    colors:
      # Background surfaces
      background-100: "#ffffff"
      background-200: "#f4f4f5"
      background-300: "#e4e4e7"

      # Gray solid (100 lightest fill → 1000 primary text on this theme)
      gray-100: "#fafafa"
      gray-200: "#f4f4f5"
      gray-300: "#e4e4e7"
      gray-400: "#d4d4d8"
      gray-500: "#a1a1aa"
      gray-600: "#71717a"
      gray-700: "#52525b"
      gray-800: "#3f3f46"
      gray-900: "#3d3d3d"
      gray-1000: "#111111"

      # Gray alpha (translucent overlays / borders / dividers)
      gray-alpha-100: "#0000000d"
      gray-alpha-200: "#00000014"
      gray-alpha-300: "#0000001a"
      gray-alpha-400: "#00000024"
      gray-alpha-500: "#00000036"
      gray-alpha-600: "#00000052"
      gray-alpha-700: "#00000073"
      gray-alpha-800: "#0000008f"
      gray-alpha-900: "#000000b8"
      gray-alpha-1000: "#000000e6"

      # Blue — links, focus, primary actions
      blue-100: "#eff6ff"
      blue-200: "#dbeafe"
      blue-300: "#bfdbfe"
      blue-400: "#93c5fd"
      blue-500: "#60a5fa"
      blue-600: "#3b82f6"
      blue-700: "#0066cc"
      blue-800: "#0052a3"
      blue-900: "#1e4a7a"
      blue-1000: "#0c1a2e"

      # Red — errors, destructive actions
      red-100: "#fef2f2"
      red-200: "#fee2e2"
      red-300: "#fecaca"
      red-400: "#fca5a5"
      red-500: "#f87171"
      red-600: "#ef4444"
      red-700: "#b91c1c"
      red-800: "#991b1b"
      red-900: "#7f1d1d"
      red-1000: "#450a0a"

      # Amber — warnings
      amber-100: "#fffbeb"
      amber-200: "#fef3c7"
      amber-300: "#fde68a"
      amber-400: "#fcd34d"
      amber-500: "#fbbf24"
      amber-600: "#d97706"
      amber-700: "#b45309"
      amber-800: "#92400e"
      amber-900: "#78350f"
      amber-1000: "#451a03"

      # Green — success
      green-100: "#f0fdf4"
      green-200: "#dcfce7"
      green-300: "#bbf7d0"
      green-400: "#86efac"
      green-500: "#4ade80"
      green-600: "#22c55e"
      green-700: "#16a34a"
      green-800: "#15803d"
      green-900: "#166534"
      green-1000: "#052e16"

      # Teal
      teal-100: "#f0fdfa"
      teal-200: "#ccfbf1"
      teal-300: "#99f6e4"
      teal-400: "#5eead4"
      teal-500: "#2dd4bf"
      teal-600: "#14b8a6"
      teal-700: "#0d9488"
      teal-800: "#0f766e"
      teal-900: "#115e59"
      teal-1000: "#042f2e"

      # Purple
      purple-100: "#faf5ff"
      purple-200: "#f3e8ff"
      purple-300: "#e9d5ff"
      purple-400: "#d8b4fe"
      purple-500: "#c084fc"
      purple-600: "#a855f7"
      purple-700: "#9333ea"
      purple-800: "#7e22ce"
      purple-900: "#6b21a8"
      purple-1000: "#3b0764"

      # Pink
      pink-100: "#fdf2f8"
      pink-200: "#fce7f3"
      pink-300: "#fbcfe8"
      pink-400: "#f9a8d4"
      pink-500: "#f472b6"
      pink-600: "#ec4899"
      pink-700: "#db2777"
      pink-800: "#be185d"
      pink-900: "#9d174d"
      pink-1000: "#500724"

typography:
  heading-32:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.02em
  heading-24:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.01em
  heading-20:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.01em
  heading-16:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0
  label-14:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0
  label-12:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0.01em
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
  button-14:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0
  button-12:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0
  mono-13:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
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
  24: 96px

rounded:
  sm: 6px
  md: 12px
  lg: 16px
  full: 9999px

components:
  button-primary:
    backgroundColor: "{colors.blue-700}"
    textColor: "{colors.background-100}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: 40px
  button-secondary:
    backgroundColor: "{colors.background-200}"
    textColor: "{colors.gray-1000}"
    borderColor: "{colors.gray-400}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: 40px
  button-danger:
    backgroundColor: "{colors.red-700}"
    textColor: "{colors.background-100}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: 40px
  button-disabled:
    backgroundColor: "{colors.gray-100}"
    textColor: "{colors.gray-700}"
    borderColor: "{colors.gray-400}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: 40px
  button-small:
    typography: "{typography.button-12}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
    height: 32px
  input:
    backgroundColor: "{colors.background-100}"
    textColor: "{colors.gray-1000}"
    borderColor: "{colors.gray-400}"
    typography: "{typography.label-14}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: 40px
  card:
    backgroundColor: "{colors.background-200}"
    textColor: "{colors.gray-1000}"
    borderColor: "{colors.gray-alpha-400}"
    rounded: "{rounded.md}"
    padding: 24px
  badge:
    backgroundColor: "{colors.gray-200}"
    textColor: "{colors.gray-900}"
    typography: "{typography.label-12}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
    height: 20px
  badge-success:
    backgroundColor: "{colors.green-100}"
    textColor: "{colors.green-800}"
    typography: "{typography.label-12}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
    height: 20px
  badge-warn:
    backgroundColor: "{colors.amber-100}"
    textColor: "{colors.amber-800}"
    typography: "{typography.label-12}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
    height: 20px
  badge-error:
    backgroundColor: "{colors.red-100}"
    textColor: "{colors.red-800}"
    typography: "{typography.label-12}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
    height: 20px
  table:
    backgroundColor: "{colors.background-100}"
    textColor: "{colors.gray-1000}"
    borderColor: "{colors.gray-alpha-400}"
    headerBackground: "{colors.background-200}"
    headerTypography: "{typography.label-12}"
    cellTypography: "{typography.copy-14}"
    rowHover: "{colors.gray-100}"
  sidebar:
    backgroundColor: "{colors.background-200}"
    textColor: "{colors.gray-1000}"
    mutedTextColor: "{colors.gray-900}"
    borderColor: "{colors.gray-alpha-400}"
    activeBackground: "{colors.background-300}"
    activeTextColor: "{colors.gray-1000}"
    typography: "{typography.label-14}"
  notice-success:
    backgroundColor: "{colors.green-100}"
    textColor: "{colors.green-900}"
    borderColor: "{colors.green-400}"
    typography: "{typography.copy-14}"
    rounded: "{rounded.sm}"
    padding: 16px
  notice-warn:
    backgroundColor: "{colors.amber-100}"
    textColor: "{colors.amber-900}"
    borderColor: "{colors.amber-400}"
    typography: "{typography.copy-14}"
    rounded: "{rounded.sm}"
    padding: 16px
  notice-error:
    backgroundColor: "{colors.red-100}"
    textColor: "{colors.red-900}"
    borderColor: "{colors.red-400}"
    typography: "{typography.copy-14}"
    rounded: "{rounded.sm}"
    padding: 16px
---

<!-- COMPLETENESS_LEVEL: 2 — last audited 2026-09-02 -->

# mstar-inspector Console

mstar-inspector Console is the design system for the developer dashboard
(`/dashboard`). It is a **functional ops console**: high contrast, few
decorative elements, state legible through color and copy rather than
ornament. The audience is the operator who deployed the inspector — not a
marketing surface.

**Theme contract (plan 41):** dark is the default console theme. With no
stored choice, light is an automatic override via `prefers-color-scheme:
light`. A manual **navbar theme toggle** stores `light` | `dark` in
`localStorage["mstar.dashboard.theme"]` and applies
`documentElement.dataset.theme` before first paint; the stored choice wins
over the OS preference. Supersedes the plan-29 lock (2026-09-04, user instruction, iteration 013).
Dual-theme values live in this file under `themes.dark` / `themes.light`
(same token **names**, different values). Top-level `colors:` equals
`themes.dark.colors` so `{colors.X}` component refs resolve to the runtime
default. Implementation maps these names to CSS custom properties in
`src/spa/styles/tokens.css` — light applies via `:root[data-theme="light"]`
with the `prefers-color-scheme` fallback on `:root:not([data-theme="dark"])`.

Existing Level 1 token **names** are unchanged (`background-100`,
`background-200`, `gray-1000`, `gray-900`, `blue-700`, `red-700`,
`amber-700`). The original light hex values are preserved on
`themes.light.colors` so mid-iteration SSR pages that still hardcode those
light values in `src/dashboard/views.ts` remain visually consistent until
Task 5 restyles them. Do not rename those tokens.

A separate `DESIGN.dark.md` is intentionally not used: the assignment stores
both palettes in one file under `themes:`. Level 3 dual-file parity remains
a `LEVEL3_PLACEHOLDER`.

## Colors

All values live in the frontmatter. `colors:` (dark default) is the SSOT
consumers resolve; `themes.light.colors` is the light override table.

Step intent (every non-background scale, 100–1000):

- `100` default background / subtle fill
- `200` hover background
- `300` active background
- `400` default border
- `500` hover border
- `600` active border
- `700` solid fill (brand / semantic)
- `800` solid fill hover
- `900` secondary text and icons
- `1000` primary text and icons

Usage:

- `background-100` — page canvas.
- `background-200` — cards, sidebar, navbar, table header.
- `background-300` — pressed / selected surface (sidebar active row).
- `gray-1000` — primary text.
- `gray-900` — secondary text, meta, muted hints.
- `gray-alpha-*` — hairlines, overlays, dividers; layer over any surface.
- `blue-700` — constructive primary actions, links, focus ring.
- `red-700` — errors and destructive submits (Remove, Delete, Overwrite).
- `amber-700` — warnings only.
- `green-700` — success notices and healthy badges (new at L2; L1 had no success green).
- `teal`, `purple`, `pink` — reserved accents; do not use for state that
  already has a semantic scale.

A disabled placeholder must never look like a clickable primary button: use
`button-disabled` (gray fill + `not-allowed`), never `blue-700`.

## Typography

Frontmatter `typography:` is the SSOT. System font stack — no webfonts.

Kept from L1: `heading-24`, `heading-16`, `copy-16`, `copy-14`.

- `heading-32` — rare page heroes (login wordmark-scale titles).
- `heading-24` — page title.
- `heading-20` — panel titles.
- `heading-16` — section titles, card titles.
- `label-14` / `label-12` — nav, form labels, table headers, badges.
- `copy-16` / `copy-14` — body and secondary copy.
- `button-14` / `button-12` — button labels (default / small).
- `mono-13` — ids, hashes, timestamps; use tabular figures.

Dashboard numerals: `font-variant-numeric: tabular-nums` on counts and ids.

## Spacing & Layout

Frontmatter `spacing:` is the SSOT (base 4px, 9 numbered steps). Kept L1
steps 1–16; added `24: 96px`.

Rhythm:

- Small inside a group: `spacing-2`–`spacing-3` (8–12px).
- Medium between related groups: `spacing-4` (16px).
- Large between sections: `spacing-8`+ (32px+).

Card padding: `spacing-6` (24px) default; `spacing-4` (16px) compact;
`spacing-8` (32px) hero. Page gutter: `spacing-6`. Content max-width 960px
on stacked pages; full-bleed shell + inner max-width on the SPA layout.

## Breakpoints

| Token | Min width | Layout |
|-------|-----------|--------|
| `sm` | 640px | Single column; sections stack; full-width cards (kept from L1) |
| `md` | 768px | Two-column cards; table still stacks to cards if needed |
| `lg` | 900px | Shell with sidebar + main; three-column section grids (kept from L1) |
| `xl` | 1280px | Wide console; optional extra gutter |

Manifest SSR views stay single column at every width until Task 5.

## Components

Component tokens live in frontmatter `components:` and reference `{colors.X}`
(dark default). CSS in `tokens.css` re-expresses them as custom properties
that follow the active theme because they point at color variables.

### Button

Variants: `button-primary` (blue-700), `button-danger` (red-700),
`button-secondary` (surface + gray-400 border), `button-disabled` (gray-100
fill, gray-700 text, not-allowed). Size: default 40px; `button-small` 32px.

**States** (all enabled variants):

| State | Mapping |
|-------|---------|
| hover | fill → 800 (primary/danger) or background-300 (secondary); border 400→500 |
| active | fill → 800 and translateY(0); border 400→600 |
| disabled | `button-disabled` tokens; `cursor: not-allowed`; no hover |
| focus-visible | `0 0 0 2px {background-100}, 0 0 0 4px {blue-700}` |

### Input

Default 40px. Border `gray-400`; text `gray-1000`; fill `background-100`.

| State | Mapping |
|-------|---------|
| hover | border `gray-500` |
| focus | border `blue-700` + the same two-layer focus ring as Button |
| error | border `red-700`; message below in `copy-14` + `red-700` |
| disabled | fill `gray-100`; text `gray-700`; cursor not-allowed |

### Card

`background-200` fill, `gray-alpha-400` hairline, `rounded-md`, 24px padding.
No drop shadow at L2 (elevation is Level 3).

### Badge

Pill (`rounded-full`) on `label-12`. Neutral `badge`; semantic
`badge-success` / `badge-warn` / `badge-error` (fill 100, text 800 of the
accent). Pair with text — do not signal state by color alone.

### Table

Header on `background-200` + `label-12`; cells `copy-14`; row hairline
`gray-alpha-400`; row hover `gray-100`. Tabular figures for numeric columns.

### Sidebar

Console chrome (navbar + side nav): `background-200`, hairline
`gray-alpha-400`, labels `label-14`. Active item: `background-300` fill,
`gray-1000` text. Muted meta uses `gray-900`.

### Notice (PageNotice)

`notice-success` / `notice-warn` / `notice-error`: 100 fill, 400 border,
900 text of the semantic scale, `copy-14`, `rounded-sm`, 16px padding.
Always include what happened + what to do next on error.

## Implementation mapping

| DESIGN.md | CSS (`src/spa/styles/tokens.css`) |
|-----------|-------------------------------------|
| `themes.dark.colors.X` | `:root { --X: … }` (default) |
| `themes.light.colors.X` | `:root[data-theme="light"] { --X: … }` + `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { --X: … } }` |
| `spacing.N` | `--spacing-N` |
| `rounded.K` | `--rounded-K` |
| `typography.T` | `--typo-T-*` |
| `components.C` | `--component-C-*` referencing color vars |

SPA (Task 3+) consumes `tokens.css` only. Theme switching is the manual
navbar toggle (plan 41): it stores `light` | `dark` in
`localStorage["mstar.dashboard.theme"]` and applies `data-theme` before
first paint — a stored choice wins over `prefers-color-scheme`, unset
follows the OS. Supersedes the plan-29 lock (2026-09-04, user instruction, iteration 013).
Legacy `views.ts` STYLE stays as-is until those pages migrate.


## shadcn/ui mapping layer (plan 33)

Tailwind v4 + shadcn/ui (New York) read **semantic** CSS variables from
`src/spa/styles/shadcn-theme.css`. That file bridges shadcn names to the
existing `tokens.css` custom properties (read-only). Tailwind utilities use
`@theme inline` so classes like `bg-primary` resolve through the bridge.

| shadcn variable | tokens.css / component source |
|-----------------|--------------------------------|
| `--background` | `--background-100` |
| `--foreground` | `--gray-1000` |
| `--card` / `--card-foreground` | `--card-bg` / `--card-fg` |
| `--primary` / `--primary-foreground` | `--blue-700` / `--background-100` |
| `--secondary` / `--secondary-foreground` | `--button-secondary-bg` / `--button-secondary-fg` |
| `--muted` / `--muted-foreground` | `--gray-100` / `--gray-900` |
| `--accent` / `--accent-foreground` | `--background-300` / `--gray-1000` |
| `--destructive` / `--destructive-foreground` | `--red-700` / `--background-100` |
| `--border` | `--gray-alpha-400` |
| `--input` | `--input-border` |
| `--ring` | `--blue-700` |
| `--radius` | `--rounded-sm` |
| `--sidebar` / `--sidebar-foreground` | `--sidebar-bg` / `--sidebar-fg` |
| `--sidebar-accent` / `--sidebar-accent-foreground` | `--sidebar-active-bg` / `--sidebar-active-fg` |
| `--color-sidebar-border` (Tailwind) | `--sidebar-border` (tokens only; not redefined in bridge) |

Copy-in components (plan 33 T1c) live under `src/spa/components/ui/` with
`components.json` aliases (`@/components` → `src/spa/components`,
`@/lib/utils` → `src/spa/lib/utils.ts`). Radix primitives use pinned
`@radix-ui/react-*` packages per plan Global Constraints.

### Inspiration (awesome-design-md)

Patterns borrowed at the token level (not pixel copies):

- **Linear** — sidebar-first IA, low-chrome surfaces (`background-200` chrome),
  single blue accent for constructive actions.
- **Vercel** — developer-console typography (`mono-13` for ids), tight
  `spacing-4` rhythm between groups, hairline borders via `gray-alpha-*`.
- **Supabase** — table-forward density (`table` component tokens), semantic
  reds/ambers for operational state without decorative gradients.


<!-- LEVEL3_PLACEHOLDER: Elevation (card/popover/modal shadows), Motion
(durations + easing + prefers-reduced-motion), Shapes usage table, Voice &
Content, and DESIGN.dark.md dual-file parity if the project later splits
themes. See mstar-design-md completeness-checklist § Level 3. -->
