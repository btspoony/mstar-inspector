---
version: 0.3.1
name: mstar-inspector Console
description: "Bold Signal-Cyan ops-console design system for the mstar-inspector developer dashboard. Dense, decisive, state through color + copy; one confident cyan accent on cool zinc neutrals. Dark is the default theme; light follows prefers-color-scheme until the navbar theme toggle stores a manual choice (localStorage mstar.dashboard.theme, light|dark) — the stored choice wins over the OS. Supersedes the plan-29 lock (2026-09-04, user instruction, iteration 013). v0.3 (plan 57, AD-573) is a values-only rebase: existing token names are frozen; brand, motion, and elevation enter as additive namespaces. v0.3.1 (plan 57 T2, AD-572) flips the sans stack to self-hosted Geist Sans — latin/latin-ext woff2 with font-display: swap; zh text falls back to the system stack."

# Runtime default = dark. Top-level colors: matches themes.dark.colors so
# {colors.X} component refs resolve to the console default. Light values
# live under themes.light.colors.
defaultTheme: dark
themeMechanism: "manual data-theme override (navbar toggle), prefers-color-scheme fallback"

colors:
  # Background surfaces (v0.3: cool-retuned zinc — slight blue lean carries
  # the bold language; surface steps kept close to v0.2 luminance)
  background-100: "#0a0c10"
  background-200: "#15181f"
  background-300: "#212630"

  # Gray solid (100 lightest fill → 1000 primary text on this theme)
  gray-100: "#15181f"
  gray-200: "#1b1f27"
  gray-300: "#212630"
  gray-400: "#39404d"
  gray-500: "#4d5563"
  gray-600: "#6b7482"
  gray-700: "#8b95a3"
  gray-800: "#ccd5e1"
  gray-900: "#a9b4c2"
  gray-1000: "#eef2f7"

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

  # Brand — Signal Cyan accent (v0.3, AD-571). Dark theme wears the bright
  # cyan step; light theme the deep cyan step. Never encodes alert semantics
  # (red=error, amber=warning, green=success stay authoritative).
  brand-600: "#06b6d4"
  brand-700: "#22d3ee"
  brand-800: "#67e8f9"

  # Blue — links and focus ring (non-alert duty kept per AD-571)
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
      background-100: "#0a0c10"
      background-200: "#15181f"
      background-300: "#212630"

      # Gray solid (100 lightest fill → 1000 primary text on this theme)
      gray-100: "#15181f"
      gray-200: "#1b1f27"
      gray-300: "#212630"
      gray-400: "#39404d"
      gray-500: "#4d5563"
      gray-600: "#6b7482"
      gray-700: "#8b95a3"
      gray-800: "#ccd5e1"
      gray-900: "#a9b4c2"
      gray-1000: "#eef2f7"

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

      # Brand — Signal Cyan (dark wears the bright cyan step)
      brand-600: "#06b6d4"
      brand-700: "#22d3ee"
      brand-800: "#67e8f9"

      # Blue — links, focus
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
      background-200: "#f3f5f8"
      background-300: "#e4e9f0"

      # Gray solid (100 lightest fill → 1000 primary text on this theme)
      gray-100: "#fafbfd"
      gray-200: "#f3f5f8"
      gray-300: "#e4e9f0"
      gray-400: "#ccd4df"
      gray-500: "#9aa5b4"
      gray-600: "#6d7889"
      gray-700: "#4e5969"
      gray-800: "#3a4350"
      gray-900: "#2f3742"
      gray-1000: "#0f141a"

      # Gray alpha (translucent overlays / borders / dividers; v0.3 cool base)
      gray-alpha-100: "#1019280d"
      gray-alpha-200: "#10192814"
      gray-alpha-300: "#1019281a"
      gray-alpha-400: "#10192824"
      gray-alpha-500: "#10192836"
      gray-alpha-600: "#10192852"
      gray-alpha-700: "#10192873"
      gray-alpha-800: "#1019288f"
      gray-alpha-900: "#101928b8"
      gray-alpha-1000: "#101928e6"

      # Brand — Signal Cyan (light wears the deep cyan step)
      brand-600: "#0891b2"
      brand-700: "#0e7490"
      brand-800: "#155e75"

      # Blue — links, focus
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
    fontFamily: "\"Geist Sans\", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.02em
  heading-24:
    fontFamily: "\"Geist Sans\", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.01em
  heading-20:
    fontFamily: "\"Geist Sans\", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.01em
  heading-16:
    fontFamily: "\"Geist Sans\", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0
  label-14:
    fontFamily: "\"Geist Sans\", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0
  label-12:
    fontFamily: "\"Geist Sans\", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0.01em
  copy-16:
    fontFamily: "\"Geist Sans\", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
  copy-14:
    fontFamily: "\"Geist Sans\", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: 0
  button-14:
    fontFamily: "\"Geist Sans\", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0
  button-12:
    fontFamily: "\"Geist Sans\", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
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

# Two-tier radius (AD-574): --rounded-sm is the control tier (buttons,
# inputs, selects, tabs triggers, combobox, menu items); --rounded-md is the
# container tier (cards, dialogs, popovers, panels, form shells). Container
# sits exactly +4px above control. --rounded-full stays pill-only (badges,
# avatars, spinners); micro inner corners (checkbox checks, nested chips) are
# documented exceptions.
rounded:
  sm: 8px
  md: 12px
  lg: 16px
  full: 9999px

# Motion (Level 3, v0.3). Theme-independent; short, physical, token-only.
# Movement animates transform/opacity only; color/border/shadow interaction
# transitions reuse duration/ease tokens; everything folds under
# prefers-reduced-motion.
motion:
  duration-fast: 120ms
  duration-base: 160ms
  duration-slow: 240ms
  ease-out: "cubic-bezier(0.22, 1, 0.36, 1)"
  ease-in-out: "cubic-bezier(0.65, 0, 0.35, 1)"
  reduced-motion: "prefers-reduced-motion: reduce folds every duration to 1ms — entrances render their end state, transitions become immediate"

# Elevation (Level 3, v0.3). Tinted shadows — cool slate, never pure black —
# layered over tonal surfaces; dark relies on surface steps + hairlines first,
# shadows stay whisper-quiet.
elevation:
  shadow-card:
    dark: "0 1px 2px #02061766, 0 2px 8px #02061733"
    light: "0 1px 2px #10192814, 0 2px 8px #1019280f"
  shadow-pop:
    dark: "0 4px 12px #02061780, 0 16px 40px #02061759"
    light: "0 4px 12px #1019281f, 0 16px 40px #10192829"

components:
  button-primary:
    backgroundColor: "{colors.brand-700}"
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

<!-- COMPLETENESS_LEVEL: 3 — last audited 2026-09-09 -->

# mstar-inspector Console

mstar-inspector Console is the design system for the developer dashboard
(`/dashboard`). v0.3 upgrades the voice from the plan-29 "functional ops
console" to a **bold Signal-Cyan console**: one decisive cyan accent on a
cool-retuned zinc neutral base, dense data surfaces with quiet tinted
elevation, and motion that clarifies change without decorating. Boldness is
carried by the neutral temperature shift, the brand accent, and the
two-tier radius — never by sacrificing density, scannability, or dual-theme
legibility. The audience is still the operator who deployed the inspector —
not a marketing surface.

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

**v0.3 value rebase (plan 57, AD-573):** token **names** are frozen — every
palette step (`background-*`, `gray-*`, `gray-alpha-*`, `blue-*`, `red-*`,
`amber-*`, `green-*`, plus reserved `teal`/`purple`/`pink`), component var,
and `--typo-*`/`--spacing-*`/`--rounded-*`/`--font-*` keeps its name; the
design change lands as **values**. New language surfaces enter only as
additive namespaces: `brand-*` (Signal Cyan), `shadow-card`/`shadow-pop`
(tinted elevation), `duration-*`/`ease-*` (motion). Three value sites move
together and are machine-pinned: this frontmatter →
`src/spa/styles/tokens.css` (both light branches) → the `views.ts` STYLE
subset. Staged delivery inside plan 57: Task 1 landed palette + motion +
radius + elevation; Task 2 (v0.3.1) flipped the self-hosted typeface —
`--font-sans` and every sans `fontFamily` now carry Geist Sans ahead of the
system fallbacks, with the woff2 riding the vite module graph — and the
shadcn bridge re-point (`--primary: var(--blue-700)` → `var(--brand-700)`)
plus component restyle lands in Task 3 — until T3 the rendered primary
button still reads `blue-700` while this file already declares the brand
target.

A separate `DESIGN.dark.md` is intentionally not used: the assignment stores
both palettes in one file under `themes:`.

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

- `background-100` — page canvas. v0.3 leans cool (blue-hued near-black on
  dark; pure white on light with cool gray surfaces carrying the cast).
- `background-200` — cards, sidebar, navbar, table header.
- `background-300` — pressed / selected surface (sidebar active row).
- `gray-1000` — primary text.
- `gray-900` — secondary text, meta, muted hints.
- `gray-alpha-*` — hairlines, overlays, dividers; layer over any surface.
  Light-theme alphas are tinted with the cool `#101928` base so borders sit
  quietly inside the cool palette.
- `brand-700` — the Signal Cyan accent: primary action fill, active
  navigation emphasis, brand moments (chart card shells in plan 60). Dark
  theme wears the bright step `#22d3ee`; light theme the deep step
  `#0e7490`. Brand **never** encodes error/warning/success semantics and
  never becomes a data-series color (AD-601).
- `blue-700` — links and the focus ring only (non-alert duty kept per
  AD-571); no longer the primary-action fill once the T3 bridge re-point
  lands.
- `red-700` — errors and destructive submits (Remove, Delete, Overwrite).
- `amber-700` — warnings only.
- `green-700` — success notices and healthy badges.
- `teal`, `purple`, `pink` — reserved accents; do not use for state that
  already has a semantic scale.

A disabled placeholder must never look like a clickable primary button: use
`button-disabled` (gray fill + `not-allowed`), never `brand-700` or
`blue-700`.

## Typography

Frontmatter `typography:` is the SSOT. The type identity is **Geist Sans**
(AD-572): latin/latin-ext subset woff2 self-hosted at
`src/spa/assets/fonts/` with `@font-face` declarations in
`src/spa/styles/fonts.css` — weights 400/500/600, exactly the three the
scale below declares (v0.3.1, plan 57 T2). `font-display: swap` keeps first
paint on the system stack; the declared `unicode-range` excludes CJK
codepoints, so zh text never selects the face or triggers a download and
falls back to the system entries of `--font-sans`. The face ships native
tabular figures (`tnum`). License: SIL OFL 1.1, vendored as
`src/spa/assets/fonts/OFL.txt`. The mono scale stays the system mono stack.

Kept from L1: `heading-24`, `heading-16`, `copy-16`, `copy-14`.

- `heading-32` — rare page heroes (login wordmark-scale titles).
- `heading-24` — page title.
- `heading-20` — panel titles.
- `heading-16` — section titles, card titles.
- `label-14` / `label-12` — nav, form labels, table headers, badges.
- `copy-16` / `copy-14` — body and secondary copy.
- `button-14` / `button-12` — button labels (default / small).
- `mono-13` — ids, hashes, timestamps; use tabular figures.

Dashboard numerals: `font-variant-numeric: tabular-nums` on counts, ids, and
any column of figures a user might scan or compare (table numeric columns,
stat cards, timestamps). The self-hosted face must ship tabular figures so
the existing `tabular-nums` utility keeps working without per-page CSS.

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

Manifest SSR views stay single column at every width.

## Radius — two tiers (AD-574)

- `--rounded-sm: 8px` — **control tier**: buttons, inputs, selects, tabs
  triggers, combobox, menu items. The user-directly-manipulated face.
- `--rounded-md: 12px` — **container tier**: cards, dialogs, popovers,
  panels, form shells. Always exactly +4px above the control tier so
  nesting reads as deliberate.
- `--rounded-full` — pill exception only: badges, avatars, spinners.
- Micro inner corners (`rounded-xs` / 2px checkbox indicators and similar
  nested details) are documented exceptions inside controls.

The shadcn bridge re-maps `--radius-lg`/`--radius-xl` onto
`var(--rounded-md)` (Task 3) so copy-in card faces land on the container
tier without hand edits; SSR faces already point at `--rounded-*`.

## Elevation

Tonal surfaces first, shadows second. Dark definition comes from surface
steps + `gray-alpha-*` hairlines; shadows are quiet cool-slate tints, never
pure black. Light shadows tint with the `#101928` base.

| Token | Dark | Light | Use |
|-------|------|-------|-----|
| `shadow-card` | `0 1px 2px #02061766, 0 2px 8px #02061733` | `0 1px 2px #10192814, 0 2px 8px #1019280f` | resting cards, Tier-1 primary surfaces |
| `shadow-pop` | `0 4px 12px #02061780, 0 16px 40px #02061759` | `0 4px 12px #1019281f, 0 16px 40px #10192829` | popovers, dropdowns, dialogs, toasts |

Pair each elevation with the container radius tier. Never stack `shadow-pop`
on nested surfaces.

## Motion

Motion clarifies change, never decorates. Zero new dependencies; CSS
transitions/keyframes only.

| Token | Value | Use |
|-------|-------|-----|
| `--duration-fast` | 120ms | press / micro feedback (`:active` scale) |
| `--duration-base` | 160ms | hover / focus color, border, shadow transitions |
| `--duration-slow` | 240ms | entrances, popovers, overlays (transform/opacity) |
| `--ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | entrances and anything that decelerates |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | symmetric state transitions |

Discipline (iteration 018 hard constraint #7):

- Movement-type animation (entrances, offsets, scale micro-interactions)
  animates `transform` / `opacity` only.
- Color / border / shadow interaction transitions stay, and their
  `transition` declarations consume the duration + ease tokens (no raw
  ms/cubic-bezier literals in component sources).
- `prefers-reduced-motion: reduce` folds **everything** — tokens.css drops
  all three durations to 1ms, so entrances render their end state and
  transitions become immediate. Component-level keyframes must additionally
  guard any non-token property with the same media query.
- Entrances trigger via IntersectionObserver; never a `window` scroll
  listener.
- No infinite loops except semantic state indicators (spinners).

## Components

Component tokens live in frontmatter `components:` and reference `{colors.X}`
(dark default). CSS in `tokens.css` re-expresses them as custom properties
that follow the active theme because they point at color variables.

### Button

Variants: `button-primary` (brand-700 — rendered `blue-700` until the T3
bridge re-point), `button-danger` (red-700), `button-secondary` (surface +
gray-400 border), `button-disabled` (gray-100 fill, gray-700 text,
not-allowed). Size: default 40px; `button-small` 32px.

**States** (all enabled variants):

| State | Mapping |
|-------|---------|
| hover | fill → 800 (primary/danger) or background-300 (secondary); border 400→500 |
| active | fill → 800 and translateY(0); border 400→600 |
| disabled | `button-disabled` tokens; `cursor: not-allowed`; no hover |
| focus-visible | `0 0 0 2px {background-100}, 0 0 0 4px {blue-700}` |

Transitions on color/border/shadow consume `--duration-base` +
`--ease-in-out`; the press feedback uses `--duration-fast`.

### Input

Default 40px. Border `gray-400`; text `gray-1000`; fill `background-100`.

| State | Mapping |
|-------|---------|
| hover | border `gray-500` |
| focus | border `blue-700` + the same two-layer focus ring as Button |
| error | border `red-700`; message below in `copy-14` + `red-700` |
| disabled | fill `gray-100`; text `gray-700`; cursor not-allowed |

### Card

`background-200` fill, `gray-alpha-400` hairline, container radius
(`rounded-md`, 12px), 24px padding, `shadow-card` elevation. Tier wrappers
(plan 59 `SectionCard`) may lift Tier-1 surfaces with `shadow-pop` scale
boundaries but never invent a third radius.

### Badge

Pill (`rounded-full` exception) on `label-12`. Neutral `badge`; semantic
`badge-success` / `badge-warn` / `badge-error` (fill 100, text 800 of the
accent). Pair with text — do not signal state by color alone.

### Table

Header on `background-200` + `label-12`; cells `copy-14`; row hairline
`gray-alpha-400`; row hover `gray-100`. Tabular figures for numeric columns.

### Sidebar

Console chrome (navbar + side nav): `background-200`, hairline
`gray-alpha-400`, labels `label-14`. Active item: `background-300` fill,
`gray-1000` text. Muted meta uses `gray-900`. Plan 58 may express the
active state with a brand accent edge; the fill stays neutral.

### Notice (PageNotice)

`notice-success` / `notice-warn` / `notice-error`: 100 fill, 400 border,
900 text of the semantic scale, `copy-14`, control radius (`rounded-sm`),
16px padding. Always include what happened + what to do next on error.

## Voice & content

- Sentences over labels: notices state what happened and what to do next.
- Numbers stay tabular and unit-suffixed (`3 apps`, `12 findings`).
- Error copy never blames the user; actions are verbs ("Retry", "Remove").
- zh-CN copy mirrors en structure; i18n keys move atomically.

## Implementation mapping

| DESIGN.md | CSS (`src/spa/styles/tokens.css`) |
|-----------|-------------------------------------|
| `themes.dark.colors.X` | `:root { --X: … }` (default) |
| `themes.light.colors.X` | `:root[data-theme="light"] { --X: … }` + `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { --X: … } }` |
| `spacing.N` | `--spacing-N` |
| `rounded.K` | `--rounded-K` |
| `typography.T` | `--typo-T-*` |
| `motion.X` | `--duration-fast/base/slow`, `--ease-out`, `--ease-in-out` on `:root` (theme-independent); the reduce media query folds durations to 1ms |
| `elevation.shadow-*` | `--shadow-card`, `--shadow-pop` — dark on `:root`, light overrides on both light branches |
| `components.C` | `--component-C-*` referencing color vars |

SPA consumes `tokens.css` only. Theme switching is the manual navbar toggle
(plan 41): it stores `light` | `dark` in
`localStorage["mstar.dashboard.theme"]` and applies `data-theme` before
first paint — a stored choice wins over `prefers-color-scheme`, unset
follows the OS. Supersedes the plan-29 lock (2026-09-04, user instruction, iteration 013).
Legacy `views.ts` STYLE keeps its own copied token subset with the same
cascade — dark `:root` default, `:root[data-theme="light"]` for the stored
choice, OS-light fallback guarded by `:root:not([data-theme="dark"])`,
explicit dark no-op — and honors it via the pre-paint bootstrap snippet
inlined in `page()` (plan 45 T8): SSR faces apply `data-theme` before
first paint while staying zero client runtime (snippet only, no bundle).
The three value sites (this file, tokens.css, views.ts STYLE) are pinned
equal by `tests/spa/tokens.test.ts`.

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
| `--primary` / `--primary-foreground` | `--blue-700` / `--background-100` (v0.3 target: `--brand-700`, re-pointed in plan 57 T3.1) |
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
  one decisive accent for constructive actions.
- **Vercel** — developer-console typography (`mono-13` for ids), tight
  `spacing-4` rhythm between groups, hairline borders via `gray-alpha-*`.
- **Supabase** — table-forward density (`table` component tokens), semantic
  reds/ambers for operational state without decorative gradients.

## Appendix A — contrast verification (WCAG 2.x, actual consumer pairs)

Computed over the v0.3 values (plan 57 T1.1; text bar ≥4.5:1, large-text /
non-text UI bar ≥3:1). Machine-pinned for the core pairs in
`tests/spa/tokens.test.ts`.

| Consumer pair | Dark | Light |
|---------------|------|-------|
| body text `gray-1000` vs page `background-100` (text) | 17.4:1 | 18.5:1 |
| body text `gray-1000` vs card `background-200` (text) | 15.8:1 | 16.9:1 |
| secondary text `gray-900` vs card (text) | 8.5:1 | 11.0:1 |
| muted `gray-700` vs card (text) | 5.9:1 | 6.5:1 |
| brand accent `brand-700` vs page (text) | 10.8:1 | 5.4:1 |
| brand accent `brand-700` vs card (text) | 9.8:1 | 4.9:1 |
| button label `background-100` on `brand-700` fill (text) | 10.8:1 | 5.4:1 |
| chart fill `blue-700` vs card (non-text) | 6.7:1 | 5.1:1 |
| chart fill `green-700` vs card (non-text) | 10.2:1 | 3.0:1 |
| chart fill `amber-700` vs card (non-text) | 10.6:1 | 4.6:1 |
| chart fill `red-700` vs card (non-text) | 6.4:1 | 5.9:1 |

All pairs clear their bar in both themes. (Light `green-700` vs card is the
v0.2-unchanged semantic value at 3.0:1 — passes the non-text bar exactly;
it is not used as text.)

Brand-vs-semantic distinguishability (CIE76 ΔE, hue delta):

| Pair | Dark | Light |
|------|------|-------|
| `brand-700` vs `green-700` | ΔE 65.9 (Δhue 46°) | ΔE 71.6 (Δhue 51°) |
| `brand-700` vs `red-700` | ΔE 98.8 (Δhue 188°) | ΔE 99.8 (Δhue 193°) |
| `brand-700` vs `amber-700` | ΔE 110.3 (Δhue 145°) | ΔE 92.9 (Δhue 167°) |

## Appendix B — Signal Cyan palette candidates (AD-571)

Three calibration candidates inside the locked Signal Cyan direction; each
with the required neutral retune (cool zinc/blue-leaning gray + background
shift is shared by all three).

| Candidate | Dark 700 | Light 700 | Verdict |
|-----------|----------|-----------|---------|
| **A — Tailwind cyan anchors (adopted)** | `#22d3ee` | `#0e7490` | Brightest separation from green while reading unmistakably cyan; 5.4:1 text on white; brand-800 hover steps map cleanly (dark brightens, light deepens). Adopted. |
| B — teal-leaning cyan | `#2dd4bf` | `#0d9488` | Rejected: ΔE vs green-700 collapses to 39–44 (Δhue ~31–33°) — too close to the success scale; light on-card contrast 3.4:1 fails the text bar. |
| C — blue-leaning cyan (sky) | `#38bdf8` | `#0369a1` | Rejected: hue 198–210° sits in blue-700's link/focus territory (ΔE 26 vs dark blue-700) — blurs the brand-vs-link distinction AD-571 keeps separate. |


<!-- LEVEL3_PLACEHOLDER: DESIGN.dark.md dual-file parity remains the only
unimplemented Level 3 item (intentionally deferred — themes live in one
file). Elevation, Motion, Shapes, and Voice & Content are in place as of
v0.3. See mstar-design-md completeness-checklist § Level 3. -->
