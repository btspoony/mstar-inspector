---
version: "0.5"
name: mstar-inspector Console
description: "Bold Signal-Cyan ops-console design system for the mstar-inspector developer dashboard. Dense, decisive, state through color + copy; one confident cyan accent on cool zinc neutrals. v0.5 rebuilds the document onto the generated fixture: the D14 band-rule palette (the 26 surviving steps), a 126-token semantic layer that component and page code consume exclusively (the rebuild ran 2026-10-31 → 2026-11-01; the SSR face landed in the dashboard surface pass, a few SPA files still read primitive steps), and a component layer composed from it. Dark is the default theme — deterministic in every browser; the navbar theme toggle stores a manual choice (localStorage mstar.dashboard.theme, light|dark) and the stored choice wins; unset renders dark (the OS preference is not consulted); light is a first-class face, not a parity checkbox. Supersedes the earlier theme lock (2026-09-04, user instruction). Upstream direction: baseline reference → token source → generated stylesheet and fixture → this document; the document is raised onto the fixture, never the reverse."

# Runtime default = dark. Top-level colors: mirrors themes.dark.colors so
# {colors.X} component refs resolve to the console default. Light values
# live under themes.light.colors.
defaultTheme: dark
themeMechanism: "manual data-theme override (navbar toggle); unset = dark default"

colors:
  # survivor — surface planes (neutral solids ladder)
  background-100: "#0a0c10"
  background-200: "#15181f"
  background-300: "#212630"
  gray-200: "#1b1f27"
  gray-600: "#6b7482"
  gray-700: "#8b95a3"
  gray-900: "#a9b4c2"
  gray-1000: "#eef2f7"
  gray-alpha-400: "#ffffff2e"
  gray-alpha-500: "#ffffff3d"
  brand-600: "#06b6d4"
  brand-700: "#22d3ee"
  blue-700: "#4ea1ff"
  red-100: "#2a1215"
  red-400: "#7f1d1d"
  red-700: "#f87171"
  amber-100: "#27190a"
  amber-400: "#78350f"
  amber-600: "#d97706"
  amber-700: "#fbbf24"
  green-100: "#052e16"
  green-300: "#14532d"
  green-400: "#166534"
  green-700: "#4ade80"
  green-800: "#86efac"
  purple-700: "#c084fc"
  # semantic — surfaces
  surface-page: "#0a0c10"
  surface-shell: "#0d1015"
  surface-raised: "#12151b"
  surface-card: "#15181f"
  surface-inset: "#1b1f27"
  surface-overlay: "#212630"
  surface-scrim: "#0a0c10cc"
  border-subtle: "#ffffff1a"
  border-default: "#ffffff2e"
  border-strong: "#ffffff3d"
  text-primary: "#eef2f7"
  text-secondary: "#a9b4c2"
  text-muted: "#8b95a3"
  text-faint: "#6b7482"
  tone-neutral-bg: "#1b1f27"
  tone-neutral-border: "#ffffff2e"
  tone-neutral-fg: "#a9b4c2"
  tone-neutral-solid: "#8b95a3"
  tone-accent-bg: "#042f2e"
  tone-accent-border: "#155e75"
  tone-accent-fg: "#22d3ee"
  tone-accent-solid: "#22d3ee"
  tone-success-bg: "#052e16"
  tone-success-border: "#166534"
  tone-success-fg: "#4ade80"
  tone-success-solid: "#4ade80"
  tone-warn-bg: "#27190a"
  tone-warn-border: "#78350f"
  tone-warn-fg: "#fbbf24"
  tone-warn-solid: "#fbbf24"
  tone-danger-bg: "#2a1215"
  tone-danger-border: "#7f1d1d"
  tone-danger-fg: "#f87171"
  tone-danger-solid: "#f87171"
  chart-1: "#06b6d4"
  chart-2: "#16a34a"
  chart-3: "#d97706"
  chart-4: "#dc2626"
  chart-5: "#2d6bb0"
  chart-6: "#9333ea"
  chart-1-mark: "#22d3ee"
  chart-2-mark: "#4ade80"
  chart-3-mark: "#fbbf24"
  chart-4-mark: "#f87171"
  chart-5-mark: "#4ea1ff"
  chart-6-mark: "#c084fc"
  on-brand: "#06222a"
  focus-ring: "#4ea1ff"

themes:
  default: dark
  mechanism: "manual data-theme override (navbar toggle); unset = dark default"
  # Manual theme contract: the navbar toggle stores light|dark in
  # localStorage["mstar.dashboard.theme"] and applies documentElement[data-theme]
  # before first paint; the stored choice wins and unset renders dark — no OS
  # fallback, deterministic across browsers (v0.3.4, 2026-09-16).
  dark:
    colors:
      # survivor — surface planes (neutral solids ladder)
      background-100: "#0a0c10"
      background-200: "#15181f"
      background-300: "#212630"
      gray-200: "#1b1f27"
      gray-600: "#6b7482"
      gray-700: "#8b95a3"
      gray-900: "#a9b4c2"
      gray-1000: "#eef2f7"
      gray-alpha-400: "#ffffff2e"
      gray-alpha-500: "#ffffff3d"
      brand-600: "#06b6d4"
      brand-700: "#22d3ee"
      blue-700: "#4ea1ff"
      red-100: "#2a1215"
      red-400: "#7f1d1d"
      red-700: "#f87171"
      amber-100: "#27190a"
      amber-400: "#78350f"
      amber-600: "#d97706"
      amber-700: "#fbbf24"
      green-100: "#052e16"
      green-300: "#14532d"
      green-400: "#166534"
      green-700: "#4ade80"
      green-800: "#86efac"
      purple-700: "#c084fc"
      # semantic — surfaces
      surface-page: "#0a0c10"
      surface-shell: "#0d1015"
      surface-raised: "#12151b"
      surface-card: "#15181f"
      surface-inset: "#1b1f27"
      surface-overlay: "#212630"
      surface-scrim: "#0a0c10cc"
      border-subtle: "#ffffff1a"
      border-default: "#ffffff2e"
      border-strong: "#ffffff3d"
      text-primary: "#eef2f7"
      text-secondary: "#a9b4c2"
      text-muted: "#8b95a3"
      text-faint: "#6b7482"
      tone-neutral-bg: "#1b1f27"
      tone-neutral-border: "#ffffff2e"
      tone-neutral-fg: "#a9b4c2"
      tone-neutral-solid: "#8b95a3"
      tone-accent-bg: "#042f2e"
      tone-accent-border: "#155e75"
      tone-accent-fg: "#22d3ee"
      tone-accent-solid: "#22d3ee"
      tone-success-bg: "#052e16"
      tone-success-border: "#166534"
      tone-success-fg: "#4ade80"
      tone-success-solid: "#4ade80"
      tone-warn-bg: "#27190a"
      tone-warn-border: "#78350f"
      tone-warn-fg: "#fbbf24"
      tone-warn-solid: "#fbbf24"
      tone-danger-bg: "#2a1215"
      tone-danger-border: "#7f1d1d"
      tone-danger-fg: "#f87171"
      tone-danger-solid: "#f87171"
      chart-1: "#06b6d4"
      chart-2: "#16a34a"
      chart-3: "#d97706"
      chart-4: "#dc2626"
      chart-5: "#2d6bb0"
      chart-6: "#9333ea"
      chart-1-mark: "#22d3ee"
      chart-2-mark: "#4ade80"
      chart-3-mark: "#fbbf24"
      chart-4-mark: "#f87171"
      chart-5-mark: "#4ea1ff"
      chart-6-mark: "#c084fc"
      on-brand: "#06222a"
      focus-ring: "#4ea1ff"
  light:
    colors:
      # survivor — surface planes (neutral solids ladder)
      background-100: "#ffffff"
      background-200: "#f3f5f8"
      background-300: "#e4e9f0"
      gray-200: "#f3f5f8"
      gray-600: "#6d7889"
      gray-700: "#4e5969"
      gray-900: "#2f3742"
      gray-1000: "#0f141a"
      gray-alpha-400: "#10192824"
      gray-alpha-500: "#10192836"
      brand-600: "#0891b2"
      brand-700: "#0e7490"
      blue-700: "#0066cc"
      red-100: "#fef2f2"
      red-400: "#fca5a5"
      red-700: "#b91c1c"
      amber-100: "#fffbeb"
      amber-400: "#fcd34d"
      amber-600: "#d97706"
      amber-700: "#b45309"
      green-100: "#f0fdf4"
      green-300: "#bbf7d0"
      green-400: "#86efac"
      green-700: "#16a34a"
      green-800: "#15803d"
      purple-700: "#9333ea"
      # semantic — surfaces
      surface-page: "#ffffff"
      surface-shell: "#f7f9fb"
      surface-raised: "#f3f5f8"
      surface-card: "#ffffff"
      surface-inset: "#f3f5f8"
      surface-overlay: "#e4e9f0"
      surface-scrim: "#101928cc"
      border-subtle: "#1019280f"
      border-default: "#10192824"
      border-strong: "#10192836"
      text-primary: "#0f141a"
      text-secondary: "#2f3742"
      text-muted: "#4e5969"
      text-faint: "#6d7889"
      tone-neutral-bg: "#f3f5f8"
      tone-neutral-border: "#10192824"
      tone-neutral-fg: "#4e5969"
      tone-neutral-solid: "#6d7889"
      tone-accent-bg: "#ecfeff"
      tone-accent-border: "#a5f3fc"
      tone-accent-fg: "#0e7490"
      tone-accent-solid: "#0e7490"
      tone-success-bg: "#f0fdf4"
      tone-success-border: "#bbf7d0"
      tone-success-fg: "#15803d"
      tone-success-solid: "#16a34a"
      tone-warn-bg: "#fffbeb"
      tone-warn-border: "#fde68a"
      tone-warn-fg: "#b45309"
      tone-warn-solid: "#d97706"
      tone-danger-bg: "#fef2f2"
      tone-danger-border: "#fecaca"
      tone-danger-fg: "#b91c1c"
      tone-danger-solid: "#dc2626"
      chart-1: "#0891b2"
      chart-2: "#16a34a"
      chart-3: "#d97706"
      chart-4: "#dc2626"
      chart-5: "#2563a8"
      chart-6: "#9333ea"
      chart-1-mark: "#0e7490"
      chart-2-mark: "#16a34a"
      chart-3-mark: "#b45309"
      chart-4-mark: "#b91c1c"
      chart-5-mark: "#0066cc"
      chart-6-mark: "#9333ea"
      on-brand: "#ffffff"
      focus-ring: "#0066cc"

typography:
  heading-32:
    fontFamily: '"Geist Sans", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
    fontSize: "32px"
    fontWeight: "600"
    lineHeight: "1.2"
    letterSpacing: "-0.02em"
  heading-24:
    fontFamily: '"Geist Sans", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
    fontSize: "24px"
    fontWeight: "600"
    lineHeight: "1.25"
    letterSpacing: "-0.01em"
  heading-20:
    fontFamily: '"Geist Sans", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
    fontSize: "20px"
    fontWeight: "600"
    lineHeight: "1.3"
    letterSpacing: "-0.01em"
  heading-16:
    fontFamily: '"Geist Sans", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
    fontSize: "16px"
    fontWeight: "600"
    lineHeight: "1.4"
    letterSpacing: "0"
  label-14:
    fontFamily: '"Geist Sans", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
    fontSize: "14px"
    fontWeight: "500"
    lineHeight: "1.4"
    letterSpacing: "0"
  label-12:
    fontFamily: '"Geist Sans", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
    fontSize: "12px"
    fontWeight: "500"
    lineHeight: "1.4"
    letterSpacing: "0.01em"
  copy-16:
    fontFamily: '"Geist Sans", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
    fontSize: "16px"
    fontWeight: "400"
    lineHeight: "1.6"
    letterSpacing: "0"
  copy-14:
    fontFamily: '"Geist Sans", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
    fontSize: "14px"
    fontWeight: "400"
    lineHeight: "1.55"
    letterSpacing: "0"
  button-14:
    fontFamily: '"Geist Sans", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
    fontSize: "14px"
    fontWeight: "500"
    lineHeight: "1.4"
    letterSpacing: "0"
  button-12:
    fontFamily: '"Geist Sans", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
    fontSize: "12px"
    fontWeight: "500"
    lineHeight: "1.4"
    letterSpacing: "0"
  mono-13:
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
    fontSize: "13px"
    fontWeight: "400"
    lineHeight: "1.5"
    letterSpacing: "0"

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

# Two-tier radius (AD-574): sm is the control tier (buttons, inputs, menu
# items), md the container tier (cards, dialogs, panels) at exactly +4px,
# full is pill-only (badges, avatars, spinners).
rounded:
  sm: 8px
  md: 12px
  full: 9999px

# Theme-independent; short, physical, token-only. Movement animates
# transform/opacity only; interaction transitions reuse duration/ease tokens;
# everything folds under prefers-reduced-motion.
motion:
  duration-fast: "120ms"
  duration-base: "160ms"
  duration-slow: "240ms"
  ease-out: "cubic-bezier(0.22, 1, 0.36, 1)"
  ease-in-out: "cubic-bezier(0.65, 0, 0.35, 1)"
  reduced-motion: "prefers-reduced-motion: reduce folds every duration to 1ms — entrances render their end state, transitions become immediate"

# Tinted shadows — cool slate, never pure black — layered over tonal
# surfaces; dark relies on surface steps + hairlines first, shadows stay
# whisper-quiet. The pop pair is the r3 baseline's (v0.5 raised it onto the
# fixture).
elevation:
  shadow-card:
    dark: "0 1px 2px #02061766, 0 2px 8px #02061733"
    light: "0 1px 2px #10192814, 0 2px 8px #1019280f"
  shadow-pop:
    dark: "0 8px 24px #02061799, 0 2px 6px #02061766"
    light: "0 8px 24px #1019281f, 0 2px 6px #10192814"

components:
  # The component layer restated in this file's variant shape. Values follow
  # the active theme; hover on the primary action is the brand-600 step.
  button-primary:
    backgroundColor: "{colors.tone-accent-solid}"
    textColor: "{colors.on-brand}"
    borderColor: "{colors.tone-accent-solid}"
    hoverBackground: "{colors.brand-600}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: 40px
  button-secondary:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.text-primary}"
    borderColor: "{colors.border-strong}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: 40px
  button-ghost:
    textColor: "{colors.text-muted}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    height: 40px
  button-danger:
    backgroundColor: "{colors.tone-danger-bg}"
    textColor: "{colors.tone-danger-fg}"
    borderColor: "{colors.tone-danger-border}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: 40px
  button-disabled:
    backgroundColor: "{colors.surface-inset}"
    textColor: "{colors.text-faint}"
    borderColor: "{colors.border-default}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: 40px
  # Sizes ride the control-height tokens; only typography/padding/height vary.
  button-sm:
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: 32px
  button-xs:
    typography: "{typography.button-12}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
    height: 24px
  input:
    backgroundColor: "{colors.surface-page}"
    textColor: "{colors.text-primary}"
    borderColor: "{colors.border-default}"
    placeholderColor: "{colors.text-faint}"
    typography: "{typography.label-14}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: 40px
  card:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.text-primary}"
    borderColor: "{colors.border-default}"
    rounded: "{rounded.md}"
    padding: 24px
  # Pattern faces — composed from the vocabulary; the {path} refs they keep
  # must resolve (no component-to-component refs, no spacing refs: the
  # frontmatter reference grammar is colors/typography/rounded only).
  group-card:
    backgroundColor: "{colors.surface-card}"
    borderColor: "{colors.border-default}"
    rounded: "{rounded.md}"
    headerPadding: "14px 16px"
    bodyPadding: "0 16px 14px"
    titleTypography: "{typography.heading-16}"
    subtitleTypography: "{typography.label-12}"
    subtitleTextColor: "{colors.text-muted}"
    headerAction: "button-sm — the 32px control face"
  list-row:
    borderColor: "{colors.border-default}"
    rounded: "{rounded.sm}"
    rowBackgroundColor: "{colors.surface-inset}"
    rowPadding: "9px 12px"
    separator: "1px border-subtle"
    identityTypography: "{typography.label-14}"
    identityFontFamily: "font-mono"
    identityMinWidth: 76px
    statusSlot: "the tone system pill"
    metaTypography: "{typography.label-12}"
    metaTextColor: "{colors.text-muted}"
    action: "ghost button-sm"
    slotOrder: "identity, status, meta, actions"
    columnGap: 12px
  step-dialog:
    surface: "inherits ui/dialog DialogContent — container radius, shadow-pop, sm:max-w-lg, p-6"
    titleTypography: "{typography.heading-16}"
    descriptionTypography: "{typography.label-12}"
    descriptionTextColor: "{colors.text-muted}"
    stepIndicatorTypography: "{typography.label-12}"
    stepIndicatorTextColor: "{colors.text-muted}"
    stepIndicatorActiveTextColor: "{colors.tone-accent-fg}"
    footerAlign: "right"
    footerGap: 8px
---
<!-- COMPLETENESS_LEVEL: 3 — last audited 2026-10-31 -->

# mstar-inspector Console

mstar-inspector Console is the design system for the developer dashboard
(`/dashboard`): one decisive cyan accent on a cool-retuned zinc neutral base,
dense data surfaces with quiet tinted elevation, and motion that clarifies
change without decorating. Boldness is carried by the neutral temperature
shift, the brand accent, and the two-tier radius — never by sacrificing
density, scannability, or dual-theme legibility. The audience is the operator
who deployed the inspector — not a marketing surface.

**v0.5** rebuilds this document onto the generated fixture. The palette is the
band-rule reduction (the 26 surviving steps), the
semantic layer is the vocabulary every component consumes, and this file states
what the machine truth already holds: where the two disagree, the fixture wins
and this document is wrong.

## Upstream direction — baseline → tokens → fixture → this document

One direction, four stations. Nothing is ever edited downstream and pushed
back up:

1. **Baseline** — `src/design-system/baseline/reference.html`, the approved
   r3 prototype surface (origin and revision in its header), committed and
   read-only. It is the design; where it is silent, the decision and its
   reason live in this document or in the recorded compass decisions it
   cites (D14/D14a/D15/D16).
2. **Token source** — `src/design-system/tokens/`, the only hand-editable
   artifact of the system. Three layers, both themes, TypeScript-checked.
3. **Generated artifacts** — `src/spa/styles/tokens.css`
   (`bun scripts/build-tokens.ts`), `src/design-system/fixture.json`
   (`bun scripts/build-fixture.ts`) and `dist/design-preview.html`
   (`bun scripts/build-design-preview.tsx`, which `bun run build:spa` runs
   before vite), each with a `--check` drift mode.
   The two committed ones are never hand-edited; a regenerated diff that does
   not match fails the build. The preview is build material, so its check
   asserts coverage instead: every declared token carries an entry, in both
   themes, at its resolved value, with a specimen its family can draw. Its
   coverage check runs on the generating path too, so a build that cannot draw
   the page fails instead of emitting a partial one — and it lands in `dist/`,
   beside the served `dist/spa/` tree rather than inside it.
4. **This document** — raised onto the fixture, never the reverse. The
   `fixture → DESIGN.md` link of `bun scripts/design-system-check.ts`
   compares every fixture token that has a frontmatter slot, both ways: a
   value the document has not caught up with, and a palette step the source
   dropped that the document still declares, both fail the check.

`mstar design-md validate .` is the local second gate: frontmatter shape and
that every `{path}` component reference resolves. A green validate on its own
is not acceptance — the chain check must also be green.

## Recorded divergences from the baseline

The baseline is the r3 prototype surface; the shipped console is the product.
Six structural places where the product does not mirror it are **intent, not
accident** — recorded here with what ships and why, so the next change reads
them as decisions instead of re-deriving them. A divergence not listed below
has no decision behind it: that is a defect, reported rather than absorbed.
All six were verified against the shipped code on 2026-11-01 for the v1.6
cleanup (compass D6; the sidebar is D5).

- **Apps list columns** — five, not the baseline's four: identity (avatar,
  name link, App id), status pill, health, creator, detail link. The health
  cell carries the latest delivery and its outcome, with the 24h rejection
  count folded into it and painted in the danger token only when it is
  non-zero. Creator is **who, not when**: an admin scans ownership without
  opening each App. The detail link is an explicit destination, the same href
  as the name. The dedicated 24h column stays folded because a non-zero count
  carries danger, not because five columns beat four.
- **Seats** — the settings flow carries a role-to-chain mapping the baseline
  omits: one select per audit seat, each resolving to Default or a named
  chain. Seats follow the chains they bind, so the section sits after them.
- **GitHub link placement** — the App's GitHub name in the identity section is
  the anchor: a manager lands on the GitHub App settings URL, a member on the
  public page. The detail header's action slot carries the status badge and no
  GitHub button — a header button duplicated the anchor and could not carry
  the manager/member split.
- **App detail section order** — identity, installations, runtime & harness,
  providers, chains, seats, destructive ops. Providers before chains, seats
  after chains, destructive ops last. The baseline specimen is shorter and
  omits providers and seats.
- **Sidebar** — three flat items (Apps, Members, Settings) in one group, no
  group headings, and the shell model carries no group field. The baseline §7
  sidebar is a pattern specimen, not the nav contract: its items (model
  providers, workspace settings, help and tickets) are not this product's
  destinations, and headings over three items would invent a support
  destination and a Settings group whose only child is Settings. The operator
  console entry sits in the footer, outside the item list.
- **Empty face** — the Apps empty state owns the one create action, and the
  header yields its action slot while the list is empty, so the page never
  renders two submits. The action is present where the guidance is; a second
  header button would either duplicate the form or pull the action out of the
  guidance card.

## Theme contract

Dark is the default console theme — deterministic in every browser. The
`prefers-color-scheme` OS fallback is gone (v0.3.4, 2026-09-16, user feedback
round): with no stored choice every face renders dark regardless of the OS
preference. A manual **navbar theme toggle** stores `light` | `dark` in
`localStorage["mstar.dashboard.theme"]` and applies
`documentElement.dataset.theme` before first paint; the stored choice wins.
Supersedes the earlier theme lock (2026-09-04, user instruction).

Tailwind's `dark:` variant is bound to that same condition: `@custom-variant
dark` in `src/spa/styles/shadcn-theme.css` keys on
`:root:not([data-theme="light"])` — dark is the attribute's *absence*, so the
never-toggled visitor is covered. The authored-source ban stands (the cascade
is the one theme mechanism); the binding only makes the spellings a text scan
cannot see — a runtime-composed class name, a copy-in upstream component —
follow the stored theme instead of the OS.

Dual-theme values live in this file under `themes.dark` / `themes.light`
(same token **names**, different values). Top-level `colors:` equals
`themes.dark.colors` so `{colors.X}` component refs resolve to the runtime
default. Implementation maps these names to CSS custom properties in
`src/spa/styles/tokens.css` — dark on `:root`, light only via the
stored-choice branch `:root[data-theme="light"]`, and the SPA `body` canvas is
painted `var(--surface-page)`. Light is a **first-class face** (compass D8):
it gets its own acceptance pass, not a parity checkbox — see the
Light theme section below.

A separate `DESIGN.dark.md` is intentionally not used: both palettes live in
one file under `themes:`.

## The three token layers

| Layer | Count | Contains | May reference |
|-------|-------|----------|---------------|
| primitive | 32 | 26 palette steps, 2 font stacks, 4 breakpoints | nothing — raw values only |
| semantic | 126 | 47 themed colours, 5 control/row heights, 3 radii, 9 spacing steps, 55 typography properties, 5 motion values, 2 shadows | the primitive layer |
| component | 33 | button variants and sizes, the text field, the card | **the semantic layer only**, with two recorded carve-outs: `button-primary-hover-bg` names the primitive `brand-600` (the approved r3 hover — the accent fg equals the accent solid, so hovering through it would be invisible), and the padding values (`button-padding-xs/sm/md`, `field-padding`) are literals, not tokens |

The boundary rule is a **fact** of the tree as of 2026-11-01 (the console
migration): component and page
code consume the **semantic** layer only (`var(--surface-card)`, never
`var(--background-200)`). The operator console migrated first (`admin.html`
reads the semantic layer and the shared utility vocabulary), and the last
page-layer stylesheet (`src/spa/pages.module.css`) followed in the same plan,
so no file outside `src/design-system/` names a primitive palette step any more.
The SSR face landed with the dashboard surface pass (2026-11-01):
`src/dashboard/views.ts` paints from the
semantic and component layers, reading the generated value table rather than a
hand copy of the palette.

`tests/design-system/boundary.test.ts` enforces three things: the **module
import specifier** for TypeScript files under `src/` outside `src/design-system/`
(`@design-system` only); the **token layer** — no consumer file (`.ts`, `.tsx`,
`.css`, `.html`) may name a palette step, with the generated stylesheet as the
single declaration site; and the **theme mechanism** — no file under `src/`,
the module included, may author a `dark:` utility, because the token cascade is
the single sanctioned way to paint a theme face and an authored split bypasses
it (twenty-one utilities had drifted that way by 2026-11-01). Tailwind's
`dark:` is bound with `@custom-variant` to the cascade's own root condition —
`:root:not([data-theme="light"])`, since dark is the attribute's *absence* — so
a `dark:` the text scan cannot see (a runtime-composed class name, a copy-in
upstream component) follows the stored theme rather than the OS. The first two
read source text, so a stylesheet, an HTML shell and an inline `style`
attribute are all in scope. The palette is
therefore droppable: the D14 reduction deleted 62 of the 96 steps the old
stylesheet declared without touching a component face.

## Colors — palette by band rule (D14)

The palette is decided by **bands, not a hand-picked list**. Bands decide the
survivors; survivors decide the palette:

| Band | Rule |
|------|------|
| Surface planes | the neutral solids ladder: `background-100/200/300`, `gray-200` |
| Text | `gray-600` (faint) → `gray-700` (muted) → `gray-900` (secondary) → `gray-1000` (primary) |
| Hairlines | `gray-alpha-400/500` plus the literal subtle edge `border-subtle` |
| Tone background | the family 100 step |
| Tone border | the family 300–400 band |
| Tone foreground | family 700 in dark; 700–800 in light where 700 fails 4.5:1 on the tone background — `green-800` is the one survivor kept for exactly this pair |
| Tone solid | family 700; light may take the 600 step (`amber-600`) |
| Chart slot | a closed pair: fill = the approved quiet 600-step value (theme-fixed literal; `chart-1` follows the theme through `brand-600`, and dark `chart-5` is lifted to clear the 3:1 non-text bar on the dark raised planes), mark = the family 700 step |

**Survivors (26):** `background-100/200/300`; `gray-200/600/700/900/1000`;
`gray-alpha-400/500`; `brand-600/700`; `blue-700`; `red-100/400/700`;
`amber-100/400/600/700`; `green-100/300/400/700/800`; `purple-700`. The teal
and pink families are gone entirely: their last two steps left with the
chart-vocabulary closure (2026-10-31), which moved
`src/spa/components/charts/charts.css` onto the six closed chart slots (the
chart fills carry their own theme-fixed literals — see the chart split below —
so no palette step answers a chart family any more).

Every removed step recorded the D14 zero-reference search before it left
(`grep -rnF "(--<step>)" src tests scripts` and the declaration-site search
over `tokens.css`, `DESIGN.md` and `src/design-system`, both empty) — an
observation, not an assertion. 62 of the 96 declared steps went that way.

### The D14a transitional live list

**Closed 2026-11-01.** The list was the band rule's escape hatch: a step
dropped by it survived only while a plan that had not run yet still read it,
and it left in the commit that migrated that last consumer.

The last two were `gray-800` and `gray-alpha-200`, read only by
`src/spa/admin.html`'s inline shell. The console migration moved that shell
onto the semantic layer (`text-secondary`, `surface-overlay`, `text-muted`, plus the
shared primitive's own hairline and radius utilities), so both declarations
left the source, the generated stylesheet and this frontmatter in that one
commit. Nothing in the tree names either step now, and `transitionalSteps` in
`src/design-system/tokens/primitives.ts` is empty.

The zero-reference searches recorded at that commit:

```text
$ grep -rnF -e "(--gray-800)" -e "(--gray-alpha-200)" src tests scripts
(no output — no consumer, in code or in tests)

$ grep -rnE -- "--(gray-800|gray-alpha-200)\s*:" src/spa/styles/tokens.css DESIGN.md src/design-system
src/design-system/baseline/reference.html:43: … --gray-700: #8b95a3; --gray-800: #ccd5e1; --gray-900: …
```

The single declaration hit is the committed baseline reference
(`src/design-system/baseline/reference.html`), which captures the palette as it
stood before the reduction and keeps its own dump — it is the document the
system was converged onto, not a declaration the app reads. Neither the token
source, the generated stylesheet, this document nor any consumer names the two
steps any more.

The rule the empty list still states: a step may be added back only together
with a named closing plan, and the generated stylesheet prints that owner above
the declaration. A new consumer of a transitional step is a defect, not a
loophole.

### Composition rule

A semantic colour references a primitive step when its value equals that step
in that theme; otherwise it carries the **approved literal** — never a nearby
step re-snapped to fit. The literals are r3 values the reduction left without
a step (`surface-shell`, `surface-raised`, `border-subtle`, the accent tone
faces, most chart fills, light `tone-danger-solid`). Two carve-outs keep the
rule honest:

- **Chart fills are theme-fixed literals.** Where a fill coincides with a
  surviving step the values are equal, not linked — see the chart split
  section below.
- **`on-brand` is a fixed label face**, not a palette reference: ink on dark's
  bright cyan, white on light's deep cyan.

## The semantic vocabulary

### Surfaces

`surface-page` (the canvas) → `surface-shell` (the nav band) →
`surface-raised` (one plane up) → `surface-card` (resting cards) →
`surface-inset` (wells, inputs-in-card, quiet rows) → `surface-overlay`
(pressed/selected planes, overlays). Dark steps the planes apart with light;
light steps them with gray. Light `surface-card` is the page white itself —
a card reads by its hairline and radius there, not by fill or elevation.

`surface-scrim` is not a plane but the veil under an overlay: the page plane at
80% in dark, and the ink base at the same 80% in light. It is one of the few
tokens that does not invert with the theme, because a scrim must darken what
sits behind it — a white veil would erase light's hairline-drawn cards and give
the equally white card above it no separation. One name, two values; overlays
read it, never a literal.

### Borders

`border-subtle` (dividers inside a surface) → `border-default` (the standard
hairline) → `border-strong` (emphasis edges, secondary-button outline). Dark
wears the white alpha ladder; light tints the same alphas with the cool
`#101928` base so hairlines sit quietly inside the palette.

### Text ladder

`text-primary` → `text-secondary` → `text-muted` → `text-faint`. Faint is
**tertiary marks only — timestamps, placeholders, disabled labels — never body
copy** (Appendix A: 3.76:1 on the dark card face). Body copy is primary or
secondary.

### Tone × strength

State is a tone, not a component: `tone-{neutral,accent,success,warn,danger}`
in three strengths — **quiet** (tint withheld; edge and label carry the
meaning), **soft** (the tinted pill: `-{bg}` fill, `-{border}` edge, `-{fg}`
label), **solid** (the `-{solid}` fill with a `surface-page` label). The
label on a solid is the page ink because a tone fg is chosen to sit on its
tint, not on its own solid step. There is deliberately **no second badge or
notice component set** beside the tone system — a notice is the soft strength
of its tone at `copy-14`; a status pill is the tone system at `label-12` on
the pill radius. The accent tone doubles as the brand surface: its solid is
the primary-action fill and its label there is `on-brand`.

### focus-ring

Links and keyboard focus resolve to `focus-ring` = `blue-700` in **both**
themes. The standing repo contract keeps brand cyan off every focus face.
The two-layer focus halo is composed from `focus-ring` + the surface the
control sits on (`0 0 0 2px <surface>, 0 0 0 4px var(--focus-ring)`), so no
shadow token is needed for it.

### The chart split (fill vs mark)

`chart-{1..6}` is the **fill** face — the approved quiet 600-step value,
written as a theme-fixed literal; only `chart-1` follows the theme, through
`brand-600`. `chart-{1..6}-mark` is the **legend-swatch / stroke** face — the
family 700 step. A full stacked bar in the mark's 700 step reads as a warning
light, so large fills sit one step quieter than small marks.

Documented collision, not an oversight: in the light theme the `chart-2` and
`chart-6` **fills** coincide with the light `green-700` and `purple-700`
steps, and the light `chart-2-mark` equals the light `green-700` as well.
The fills are literals by the composition rule — a later change to those
steps must not move a chart slot, and a chart retune must not re-point the
palette.

The second theme split is a contrast fix, not a design retune: dark `chart-5`
is `#2d6bb0`, not the shared `#2563a8`, because the shared value measured
2.900:1 on `surface-card` and 2.696:1 on `surface-inset` — below the 3:1
non-text bar on two of the three dark surfaces while clearing it on the page
canvas (3.196:1). The lift keeps the blue hue and measures 3.580:1 on page,
3.249:1 on card and 3.020:1 on inset; light keeps `#2563a8` (6.125:1 on its
page white). The gate's `fills → surfaces` link measures every fill on the
page canvas and every dark fill on the raised planes, so a retune that erodes
a margin fails the gate instead of passing silently.

## The ops surface variant (D15)

"Plainer" for the operator console is one re-map, not a second system:
`data-surface="ops"` on the **admin document root** (the root, not a page
wrapper, so Radix portals — flag-confirm dialog, dropdowns, tooltips —
inherit it) re-maps a closed set of tokens to neutral emphasis:

| Base token | Ops value |
|------------|-----------|
| `tone-accent-bg` / `-border` / `-fg` / `-solid` | the `tone-neutral-*` equivalents |
| `button-primary-bg` | `tone-neutral-bg` |
| `button-primary-fg` | `text-primary` |
| `button-primary-border` | `border-strong` |
| `button-primary-hover-bg` | `surface-overlay` (one plane up the neutral ladder, so no accent leaks back through the hover) |

Every value is a reference to a token that already exists — a literal here
would be a new colour, which D15 forbids. The whole accent tone is withheld,
not individual steps; admin code may not reference `tone-accent-*` or brand
step names, and the generated `:root[data-surface="ops"]` block is asserted
by test. Requesting the accent *tone* is not naming a token: `StatusBadge
tone="accent"` stays a legal call-site request, and this re-map is what
withholds the paint.

## Control heights, rows and radii

Three named control heights — `control-h-xs` 24px, `control-h-sm` 32px,
`control-h-md` 40px — and two row heights — `row-h-compact` 38px,
`row-h-comfort` 48px. A control picks a height token, never a raw number.

Radius is two tiers plus the pill (AD-574): `radius-control` 8px — **the
control tier** (buttons, inputs, selects, tab triggers, menu items; the
user-directly-manipulated face) — and `radius-container` 12px — **the
container tier** (cards, dialogs, popovers, panels), always exactly +4px
above the control tier so nesting reads as deliberate. `radius-pill`
(9999px) stays pill-only: badges, avatars, spinners. The shadcn bridge maps
`--radius-lg`/`--radius-xl` onto the container tier so copy-in faces land
without hand edits. Micro inner corners (checkbox checks, nested chips) are
documented exceptions inside controls.

## Light theme — a first-class face

Light gets its own acceptance pass (compass D8), and it earns it — the faces
that differ by more than value:

- **The primary label flips**: `on-brand` is white on light's deep cyan
  (`tone-accent-solid` = `brand-700` light value), ink on dark's bright one.
- **`tone-success-fg` takes `green-800`** — the one step kept for this pair,
  because light `green-700` on the success tint is ≈2.9:1.
- **`tone-warn-solid` takes `amber-600`** and light `tone-danger-solid`
  carries the literal `#dc2626` (no `red-600` step exists; D14 names
  `amber-600` only).
- **`surface-card` is the page white**: with no surface step to separate it,
  a card in light is drawn by its hairline alone.
- **Charts**: `chart-1` follows the theme through `brand-600`, and dark
  `chart-5` is lifted to clear the non-text bar on the raised planes; every
  other fill is the same literal in both themes (see the chart split above).

## Typography

Frontmatter `typography:` is the SSOT. The type identity is **Geist Sans**
(AD-572): the unmodified full-latin woff2 binaries of `geist@1.7.2`
(shipped upstream as full builds, not subsets — provenance sha256 recorded
in the `fonts.css` header) self-hosted at `src/spa/assets/fonts/` with
`@font-face` declarations in `src/spa/styles/fonts.css` — weights 400/500/600,
exactly the three the scale declares. `font-display: swap` keeps first paint
on the system stack; the declared `unicode-range` excludes CJK codepoints,
so zh text never selects the face or triggers a download and falls back to
the system entries of `--font-sans`. The face ships native tabular figures
(`tnum`). License: SIL OFL 1.1, vendored as `src/spa/assets/fonts/OFL.txt`.
The mono scale stays the system mono stack.

- `heading-32` — rare page heroes (login wordmark-scale titles).
- `heading-24` — page title.
- `heading-20` — panel titles.
- `heading-16` — section titles, card titles.
- `label-14` / `label-12` — nav, form labels, table headers, badges.
- `copy-16` / `copy-14` — body and secondary copy.
- `button-14` — button labels: the default control face and the SPA small
  button (`components.button-sm`).
- `button-12` — 12px labels: the SSR dashboard header action and the SPA's
  `xs` ghost face (`components.button-xs`).
- `mono-13` — ids, hashes, timestamps; use tabular figures.

`label-12` is the scale's smallest step: there is no 11px token and no
`label-11`. A surface needing smaller text moves to `label-12`, never to a
one-off size. Dashboard numerals: `font-variant-numeric: tabular-nums` on
counts, ids, and any column of figures a user might scan or compare.

## Spacing & Layout

Frontmatter `spacing:` is the SSOT (base 4px, 9 numbered steps).

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
| `sm` | 640px | Single column; sections stack; full-width cards |
| `md` | 768px | Two-column cards; table still stacks to cards if needed |
| `lg` | 900px | Shell with sidebar + main; three-column section grids |
| `xl` | 1280px | Wide console; optional extra gutter |

Manifest SSR views stay single column at every width. Breakpoints are
body-only by the spec: they reach the document through the layout rules
above, and the source declares them as `breakpoint-*` primitives.

## Elevation

Tonal surfaces first, shadows second. Dark definition comes from surface
steps + hairlines; shadows are quiet cool-slate tints, never pure black.
Light shadows tint with the `#101928` base. Elevation marks an overlay, not a
container: content on a page is defined by its surface step and hairline.
The values below are the r3 baseline's (the v0.3 pair in this document was
superseded by the fixture in v0.5).

| Token | Dark | Light | Use |
|-------|------|-------|-----|
| `shadow-card` | `0 1px 2px #02061766, 0 2px 8px #02061733` | `0 1px 2px #10192814, 0 2px 8px #1019280f` | hand-drawn SSR boxes only; the component card carries none |
| `shadow-pop` | `0 8px 24px #02061799, 0 2px 6px #02061766` | `0 8px 24px #1019281f, 0 2px 6px #10192814` | popovers, dropdowns, dialogs, toasts |

Pair each elevation with the container radius tier. Never stack `shadow-pop`
on nested surfaces.

## Motion

Motion clarifies change, never decorates. Zero dependencies; CSS
transitions/keyframes only.

| Token | Value | Use |
|-------|-------|-----|
| `duration-fast` | 120ms | press / micro feedback (`:active` scale) |
| `duration-base` | 160ms | hover / focus color, border, shadow transitions |
| `duration-slow` | 240ms | entrances, popovers, overlays (transform/opacity) |
| `ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | entrances and anything that decelerates |
| `ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | symmetric state transitions |

Discipline:

- Entrance animations are **not currently active**: the `animate-in/out`
  classes copied from shadcn/ui emit no CSS in Tailwind 4 core (that plugin
  family lives in `tw-animate-css`, deliberately not a dependency), so those
  surfaces appear/disappear instantly. A future motion pass must be
  zero-dependency keyframes consuming `duration-slow` with a
  `prefers-reduced-motion` guard.
- Movement-type animation animates `transform` / `opacity` only.
- Color / border / shadow transitions consume the duration + ease tokens —
  no raw ms or cubic-bezier literals in component sources.
- `prefers-reduced-motion: reduce` folds **everything**: the stylesheet drops
  all three durations to 1ms, so entrances render their end state and
  transitions become immediate.
- Entrances trigger via IntersectionObserver; never a `window` scroll
  listener. No infinite loops except semantic state indicators (spinners).

## Components

Component tokens live in frontmatter `components:` and reference
`{colors.X}` (the dark default; values follow the active theme through the
var chain). The generated component layer (`--button-*`, `--field-*`,
`--card-*`) is composed from the semantic layer, never from a primitive and
never from a literal — the frontmatter entries below restate it in the
variant shape this file's schema uses.

### Button

Variants: `button-primary` (accent solid + `on-brand` label; hover is the
`brand-600` step — one step quieter than the fill in dark, deeper in light —
and `border` duplicates the fill so the ops variant can change the edge
alone), `button-secondary` (card surface + strong edge), `button-ghost`
(muted label, no fill), `button-danger` (the danger tone's soft faces),
`button-disabled` (inset fill + faint label + `not-allowed`; a disabled
placeholder must never look like a clickable primary). Sizes ride the height
tokens: default `md` 40px (`0 14px`), `button-sm` 32px (`button-14` label,
`0 12px`) — the SPA `ui/button` `size="sm"` face — and `button-xs` 24px
(`button-12` label, `0 8px`) — the SPA `size="xs"` ghost face, the in-row
action. The SSR dashboard's 32px header face reads the same size tokens
(`button-height-sm`, `button-padding-sm`, `button-radius`).

**States** (all enabled variants): hover steps the fill one plane
(primary → `brand-600`, secondary → `surface-overlay`); active holds;
disabled takes `button-disabled` with `cursor: not-allowed`;
focus-visible wears the two-layer halo (`focus-ring` + the sitting surface).
Transitions on color/border/shadow consume `duration-base` + `ease-in-out`;
press feedback uses `duration-fast`.

### Input

`field-*` in the component layer (`input` here): page fill, primary text,
`border-default` edge, `text-faint` placeholder, `label-14`, control radius,
40px, `0 12px`. States: hover holds the edge; focus wears `focus-ring` in
the two-layer halo; error takes the danger tone's border + a `copy-14`
message below; disabled takes the inset face.

### Card

`surface-card` fill, `border-default` hairline, container radius, `spacing-6`
(24px) padding, and **no elevation**: a hairline plus the surface step carries
the definition, so a card sitting on a page never lifts off it. The border
colour is always named — preflight leaves `border-color` at `currentColor`, so
a width-only border would paint the hairline in the text colour. Tier wrappers
(`SectionCard`) vary the hairline strength (emphasis vs standard) rather than
the elevation, and never invent a third radius.

### Composition primitives

Four presentational primitives are the sanctioned spelling for a dashboard
page's header, stat panel, table and status pill: `PageHeader`, `StatCard` /
`StatGrid`, `DataTable` and `StatusBadge`. They render from props only — no
hooks, no fetch — and resolve no copy: the page passes its `t()` results in.

**Rule.** Pages compose from these primitives (plus `SectionCard` /
`SectionCardTitle`). Re-spelling a primitive's class chain in a page is the
duplication this layer exists to prevent; a page whose shape genuinely
differs is reported, not absorbed by a page-specific prop.

**The fixed type scale** — `heading-24` (page title), `heading-16` (section
and card titles, the stat figure), `label-12` (uppercase muted labels, table
headers); no other step, and none smaller.

**The three spacing steps** — `spacing-6` (24px) between a page's blocks,
`spacing-4` (16px) between the cards of a `StatGrid`, `spacing-3` (12px)
inside a header column. Tighter gaps inside one primitive are that
primitive's own micro-rhythm, not a page-level choice.

**StatusBadge** maps its `tone` prop onto the tone system — `neutral` =
`tone-neutral-bg`/`-fg`, `success` / `warning` / `error` = the matching
tone's bg/fg pair, `brand` = `tone-accent-solid` with the `on-brand` label.
Shape is the pill radius at 20px. The caller passes the label and owns what
a status means; `brand` is an accent surface, never an alert.

**Documented gaps.** Two remain, and this iteration closed neither: the
outside-card section heading was closed before it, by the r3 shell pass.
`FlowSection` owns that heading — it renders the `heading-16` chain — and
`WorkspaceSetupPage` composes it, spelling no heading typography of its own
(`tests/spa/workspace-setup-page.test.ts` pins it), so the entry claiming the
page spells the chain by hand is gone. `MembersPage` still spells its own two
section headings by hand, but not on the `heading-16` chain: `font-medium
text-base` is the same 16px size at weight 500 and Tailwind's 1.5 line
height, where the chain is 600 at 1.4. `LoginPage` keeps its centred
`heading-32` hero, hand-spelled on `CardTitle`: the rare hero step, not a page
title, and no primitive owns it.

### Pattern faces

Faces composed from the vocabulary above; they own no component tokens of
their own beyond what the component layer already declares:

- **Table** — container radius + hairline shell; header band on
  `surface-raised` at `label-12`; cells `copy-14`; row hairline
  `border-subtle`; row hover `surface-inset`. Tabular figures on numeric
  columns.
- **Sidebar / console chrome** — `surface-shell` band, `border-default`
  hairline, `label-14` labels. Active item: the accent tint through the
  bridge's `--sidebar-primary` with the `on-brand`-faced label; hover and
  open-hover keep the neutral `surface-overlay` tint; no edge marker
  (AD-641 — the brand accent edge is retired). Muted meta uses
  `text-secondary`.
- **Tabs** — two faces, one component, chosen by `variant` at the
  consumption site: the **page-level line tab** (full-width list over a
  bottom hairline, `heading-16` triggers, 40px bar, active = `text-primary`
  + 2px underline) and the **embedded segmented pill** (`surface-inset`
  strip, 36px bar, `label-14` triggers on the control radius, active
  segment = `surface-card` fill + `text-primary`). Page IA navigates with
  the line face; intra-card segmentation keeps the pill; a face never mixes
  the two vocabularies.
- **Notice** — the soft strength of its tone at `copy-14`, control radius,
  `spacing-4` padding. Always state what happened and what to do next on
  error.
- **group-card** — a set of children under one parent object: `surface-card`
  + container radius + `border-default` hairline, the symmetric card padding
  split into a header band (`14px 16px`) and body (`0 16px 14px`), title on
  `heading-16`, subtitle on `label-12` in `text-muted`, the header action a
  `button-sm`. No divider under the header — the `list-row` container border
  inside the body carries the separation.
- **list-row** — isomorphic rows inside a group: an in-card inset container
  on `border-default` with the micro-corner exception at the control radius;
  rows on `surface-inset` at `9px 12px`, separated by a 1px `border-subtle`
  hairline; slot order identity → status → meta → actions on a 12px column
  gap; identity `label-14` in the mono stack at 76px minimum; the status
  slot is the tone-system pill (no dot added); meta `label-12` in
  `text-muted`; the trailing action a ghost `button-sm` — except a
  confirm-gated removal, which renders the destructive variant so the row's
  only action cannot read as a harmless one-click.
- **step-dialog** — multi-step entry inheriting `ui/dialog`'s `DialogContent`
  (container radius through the bridge, `shadow-pop`, `sm:max-w-lg`, `p-6`),
  re-deriving none of it: title `heading-16`; description `label-12` in
  `text-muted`; step indicator `label-12` — the current step in
  `tone-accent-fg`, the rest `text-muted`, rendered only when
  `steps.length > 1`, out-of-range `currentStep` clamped so exactly one step
  is always current; footer right-aligned with a `spacing-2` (8px) gap, the
  caller rendering the disabled submit and in-progress copy — the shell
  holds no busy state.

## Voice & content

- Sentences over labels: notices state what happened and what to do next.
- Numbers stay tabular and unit-suffixed (`3 apps`, `12 findings`).
- Error copy never blames the user; actions are verbs ("Retry", "Remove").
- zh-CN copy mirrors en structure; i18n keys move atomically.

## Implementation mapping

| DESIGN.md | Implementation |
|-----------|----------------|
| `themes.<theme>.colors.X` | `--X` custom properties: dark on `:root`, light on `:root[data-theme="light"]` (`src/spa/styles/tokens.css`, generated) |
| `spacing.N` | `--spacing-N` |
| `rounded.sm` / `md` / `full` | `--radius-control` / `--radius-container` / `--radius-pill` |
| `typography.T` | `--typo-T-*` |
| `motion.X` | `--duration-*` / `--ease-*` on `:root` (theme-independent); the reduce media query folds durations to 1ms |
| `elevation.shadow-*` | `--shadow-card`, `--shadow-pop` — dark on `:root`, light on the stored-light branch |
| `components.C` | `--button-*` / `--field-*` / `--card-*`, referencing semantic vars only |

The chain commands: `bun scripts/build-tokens.ts [--check]`,
`bun scripts/build-fixture.ts [--check]`,
`bun scripts/build-design-preview.tsx [--check]`, and
`bun scripts/design-system-check.ts` (all five links — the four generated ones
above, plus every hand-written stylesheet and HTML shell under `src/spa`, whose
`var(--x)` targets must still exist — the one entry point CI runs), plus
`mstar design-md validate .` (local only; the CLI installs from GitHub, so CI
does not take on that network dependency). `bun run build:spa`
is the build: it runs the preview generator (which refuses to emit a page it
cannot draw) and then vite, so every build writes `dist/design-preview.html`
beside the served `dist/spa/` tree. The SSR
`views.ts` STYLE carries the same chain's third output: its value table is
generated from this source (`src/dashboard/ssr-tokens.generated.ts`), so the
zero-build face paints what the SPA paints instead of copying it.

## shadcn/ui mapping layer

Tailwind v4 + shadcn/ui (New York) read **semantic** CSS variables from
`src/spa/styles/shadcn-theme.css`; the bridge is read-only and names no
palette step:

| shadcn variable | tokens.css |
|-----------------|------------|
| `--background` / `--foreground` | `--surface-page` / `--text-primary` |
| `--card` / `--card-foreground` | `--surface-card` / `--text-primary` |
| `--popover` / `--popover-foreground` | `--surface-raised` / `--text-primary` |
| `--primary` / `--primary-foreground` | `--button-primary-bg` / `--button-primary-fg` |
| `--primary-hover` | `--button-primary-hover-bg` (`brand-600`) |
| `--secondary` / `--secondary-hover` | `--surface-card` / `--surface-overlay` |
| `--muted` / `--muted-foreground` | `--surface-inset` / `--text-secondary` |
| `--accent` / `--accent-foreground` | `--surface-overlay` / `--text-primary` |
| `--destructive` / `--destructive-foreground` | `--tone-danger-solid` / `--on-brand` |
| `--destructive-hover` | derived: `color-mix` of the solid with 12% `text-primary` (fallback = the solid) — the reduction removed the step the old hover named |
| `--border` / `--input` | `--border-default` |
| `--ring` / `--sidebar-ring` | `--focus-ring` (focus duty stays blue app-wide) |
| `--radius` | `--radius-control` |
| `--sidebar` | `--surface-shell` |
| `--sidebar-primary` | `--tone-accent-solid` (the active-row tint derives through this key) |
| `--sidebar-accent` | `--surface-overlay` |

The primary pair names the **component** tokens rather than the accent pair
directly: `--primary` / `--primary-foreground` are what `Button`'s default
variant paints, and the D15 ops variant re-maps `button-primary-*` alone, so
this is the hop that makes the console's primary action quiet. Off the ops
surface the pair resolves to `tone-accent-solid` / `on-brand` exactly as before
(`tests/spa/tokens.test.ts` asserts the resolution, not the declaration).

The primitives live under `src/design-system/primitives/`, and consumers reach
them one way only: the `@design-system` alias onto `src/design-system/index.ts`,
mapped in `tsconfig.json`, `tsconfig.spa.json` and `vite.config.ts` (a deep
import fails typecheck and falls through the dev-server regex). The module
imports nothing from `src/spa/`; because it sits outside the Vite root,
`shadcn-theme.css` names it as a Tailwind source. Radix primitives use pinned
`@radix-ui/react-*` packages.

### Inspiration (awesome-design-md)

Patterns borrowed at the token level (not pixel copies): **Linear** —
sidebar-first IA, low-chrome surfaces, one decisive accent for constructive
actions; **Vercel** — developer-console typography (`mono-13` for ids), tight
`spacing-4` rhythm, hairline borders; **Supabase** — table-forward density,
semantic reds/ambers for operational state without decorative gradients.

## Appendix A — per-theme contrast proof (D16)

Ratios are WCAG 2.x relative-luminance over the fixture values (text bar
≥4.5:1, non-text bar ≥3:1), each measured on the face the pair actually sits
on. Pairs below their bar are **listed with their disposition, not buried**.

### on-brand (the label on the accent solid)

| Pair | Dark | Light | Disposition |
|------|------|-------|-------------|
| `on-brand` on `tone-accent-solid` | 9.15 | 5.36 | passes both themes |

### destructive (the label the filled danger button paints)

The `destructive` Button variant paints `--destructive-foreground` on
`--destructive`; the bridge resolves that pair to `on-brand` on
`tone-danger-solid`, and the hover face is the derived 12% mix. Measured on
those rendered faces, not on a neighbouring token:

| Pair | Dark | Light | Disposition |
|------|------|-------|-------------|
| `destructive-foreground` on `tone-danger-solid` | 5.98 | 4.83 | passes both themes |
| `destructive-foreground` on the derived hover face | 6.58 | 5.86 | passes both themes |

The variant previously painted `text-white` (2.77:1 on dark's `#f87171`) and
carried a `dark:` fill split, which at the time resolved from
`prefers-color-scheme` — a mechanism this document's theme contract never
consults, so the split could only fire on an OS-dark machine running the light
face. The split stays removed even though `dark:` is now bound to
`:root:not([data-theme="light"])`: the token cascade is still the one
sanctioned theme mechanism, and a split would be a second colour answer for
the same face. `tests/spa/tokens.test.ts` reads the label class out of the
component and measures that class, so a raw colour fails the test instead of
passing it.

### Tone fg pairs (the soft strength — the reading face)

| Tone | Dark | Light | Disposition |
|------|------|-------|-------------|
| neutral | 7.86 | 6.50 | passes |
| accent | 8.01 | 5.15 | passes |
| success | 8.55 | 4.79 | passes |
| warn | 10.23 | 4.84 | passes |
| danger | 6.35 | 5.91 | passes — dark danger is the floor the D14 re-point (800/900 → 700) had to keep, and it does |

### Tone solid pairs (label = `surface-page`)

| Tone | Dark | Light | Disposition |
|------|------|-------|-------------|
| neutral | 6.45 | **4.47** | below 4.5 in light — approved at D14/D16 (r3-confirmed values); constrained to the solid pill face |
| accent | 10.83 | 5.36 | passes |
| success | 11.23 | **3.30** | below 4.5 in light — approved; short status words at `label-12` only, never running text |
| warn | 11.72 | **3.19** | below 4.5 in light — approved; same constraint |
| danger | 7.08 | 4.83 | passes |

The three light below-4.5 solids are the recorded D16 exceptions: the solid
strength is a badge-scale face; the soft strength (all ≥4.79) is the reading
face.

### Chart marks vs `surface-card` (non-text bar)

| Mark | Dark | Light | Disposition |
|------|------|-------|-------------|
| `chart-1-mark` | 9.83 | 5.36 | passes |
| `chart-2-mark` | 10.19 | **3.30** | passes the 3:1 bar. **Corrected number**: D16 recorded 3.02, measured on the old `background-200` card face; v0.5's light `surface-card` is `background-100` (#ffffff), where the ratio is 3.30:1 |
| `chart-3-mark` | 10.64 | 5.02 | passes |
| `chart-4-mark` | 6.42 | 6.47 | passes |
| `chart-5-mark` | 6.65 | 5.57 | passes |
| `chart-6-mark` | 6.72 | 5.38 | passes |

### Text ladder vs `surface-card` (page in parentheses; text bar)

| Token | Dark | Light | Disposition |
|-------|------|-------|-------------|
| `text-primary` | 15.80 (17.41) | 18.50 | passes |
| `text-secondary` | 8.45 (9.31) | 12.03 | passes |
| `text-muted` | 5.86 (6.45) | 7.10 | passes |
| `text-faint` | **3.76** (4.14) | **4.47** | below 4.5 on the dark card face and marginally below on light — **never body copy**; tertiary marks only (timestamps, placeholders, disabled labels). **Corrected number**: D16's 4.14 dark figure measured the page face; on `surface-card` dark it is 3.76, so the constraint is stricter than D16 implies. Light `surface-card` equals the page white, so the light figure is 4.47 on both |

Light `surface-card` and `surface-page` are both `#ffffff`, so every light
ladder ratio is the same on either face.

## Appendix B — Signal Cyan palette candidates (AD-571)

Three calibration candidates inside the locked Signal Cyan direction; each
with the required neutral retune (cool zinc/blue-leaning gray + background
shift is shared by all three).

| Candidate | Dark 700 | Light 700 | Verdict |
|-----------|----------|-----------|---------|
| **A — Tailwind cyan anchors (adopted)** | `#22d3ee` | `#0e7490` | Brightest separation from green while reading unmistakably cyan; 5.4:1 text on white; the 600 hover step maps cleanly (dark brightens, light deepens). Adopted. |
| B — teal-leaning cyan | `#2dd4bf` | `#0d9488` | Rejected: ΔE vs green-700 collapses to 39–44 (Δhue ~31–33°) — too close to the success scale; light on-card contrast fails the text bar. |
| C — blue-leaning cyan (sky) | `#38bdf8` | `#0369a1` | Rejected: hue 198–210° sits in blue-700's link/focus territory — blurs the brand-vs-link distinction AD-571 keeps separate. |


<!-- LEVEL3_PLACEHOLDER: DESIGN.dark.md dual-file parity remains the only
unimplemented Level 3 item (intentionally deferred — themes live in one
file). Elevation, Motion, Shapes, and Voice & Content are in place as of
v0.5. See mstar-design-md completeness-checklist § Level 3. -->
