---
module: dashboard / visual foundation (shadcn + Tailwind v4 on Worker-served Vite SPA)
date: 2026-09-04
last_updated: 2026-09-10
problem_type: best_practice
category: best-practices
severity: medium
plan_id: 33-design-system-app-shell
tags: [shadcn, tailwind-v4, vite, react19, design-tokens, dark-theme, css-modules, worker]
related_components: [src/spa/styles/shadcn-theme.css, src/spa/styles/tokens.css, DESIGN.md, src/spa/components/ui/, vite.config.ts]
---

# shadcn/ui + Tailwind v4 foundation on a Worker-served Vite SPA

## Context

The dashboard SPA (React 19 + Vite 8, served by the Worker from `build:spa` output) had zero UI library and hand-rolled CSS modules. iter011 plan 33 introduced shadcn/ui + Tailwind CSS v4 as the permanent visual foundation without breaking existing pages mid-migration (plans 34–36 restyle their own surfaces later).

## Guidance

- **Bridge, don't replace**: existing `tokens.css` custom properties stay the source of truth; a `shadcn-theme.css` layer maps shadcn CSS variables (`--background`, `--foreground`, …) onto tokens via `@theme inline`. shadcn components then inherit the project palette. Dark is primary; light applies via manual override — `:root[data-theme="light"]` wins over the `@media (prefers-color-scheme: light)` fallback that guards `:root:not([data-theme="dark"])` (013 plan 41 reversed the plan-29 no-toggle lock: a navbar toggle persists `localStorage["mstar.dashboard.theme"]`, applied pre-paint by an inline bootstrap in `src/spa/index.html` before `<!--SPA_BOOT-->`); `DESIGN.md` documents the mapping table (L2 completeness).
- **SSR faces share the theme mechanism (014 plan 45)**: the legacy manifest views (`src/dashboard/views.ts`, dark `:root` default) gained the same three-part structure — `:root[data-theme="light"]` branch with the recorded light hexes (byte-identical to the media query; no token migration), the `:root:not([data-theme="dark"])` guard on the OS-light media query (stored dark must beat OS light — both directions), and the plan-41 pre-paint bootstrap snippet inside the `page()` wrapper so ONE insertion covers all SSR faces (zero client runtime beyond the snippet). Forward-note: there is no CSP in `src/` today; a future restrictive `script-src` would silently disable BOTH inline bootstraps (SPA + SSR) — revisit placement if a CSP lands.
- **Copy-in, exact-pinned**: shadcn components live in `src/spa/components/ui/` copied in via `scripts/copy-shadcn-ui.ts` (vendored registry snapshot; regen is byte-identical). Every new dep (`tailwindcss@4.x`, `@radix-ui/react-*`, `class-variance-authority`, `lucide-react`, …) pinned exact — no `^`/`~`.
- **Dual-track transition is explicit**: CSS modules and Tailwind coexist during migration; new surfaces are Tailwind-token-only; legacy chrome modules get deleted with test locks (`existsSync === false` assertions) when their surface is reworked.
- **Path aliases**: `components.json` + vite `@` resolve + `tsconfig.spa.json` paths must all target `src/spa` — keep the three in sync or imports break only at build.
- **Do not** hand-edit generated `components/ui/*`; extend via the generator or wrapper components. Radix Select cannot use `""` as a value — use a sentinel (`"all"`) mapped to omission server-side.

## Why This Matters

The bridge approach let 5 plans land UI work in one iteration without a big-bang restyle: each page migrates in its own plan while sharing one token source. Generated-component discipline + exact pins keep the supply chain auditable (Workers image has no runtime network for UI deps anyway).

## When to Apply

Any new dashboard surface, any new shadcn component need, any DESIGN.md token change. Regenerating the catalog/components must reproduce byte-identical output.

## Examples

- `src/spa/styles/shadcn-theme.css` — bridge layer (17 vars spot-verified against tokens.css).
- `tests/spa/shell.test.ts` — negative-regex locks for native controls; `home.test.ts` zero-native scan pattern.


## v0.3 design-language additions (iteration 018, 2026-09-10)

- **Token architecture (AD-573)**: semantic var names frozen; new tokens enter as additive namespaces (`--brand-*`/`--shadow-*`/`--duration-*`/`--ease-*`). Value changes sync across THREE sites — DESIGN.md frontmatter / tokens.css (both light branches byte-identical) / views.ts STYLE subset — with parity pins extended to the **reference level** (`--button-primary-bg: var(--brand-700)` in views.ts vs tokens), not just hex values (hex-only pins miss reference drift; plan-57 QC F-002).
- **SectionCard two-tier idiom (AD-591)**: `src/spa/components/SectionCard.tsx` is the single-point tier idiom (`tier: "primary" | "secondary"` composing `ui/card.tsx`). Tier faces: primary = tinted `gray-alpha-500` border + `shadow-card`; secondary = `shadow-none border-border` (the `border-border` is REQUIRED — bare `border` + preflight renders currentColor full-strength text color; see ui-bugs/tailwind4-compiled-css-traps). Pages must not hand-assemble tier classNames (pinned).
- **Radius two-tier (AD-574)**: `--rounded-sm` control step (8px) / `--rounded-md` container step (12px); `@theme inline` remaps `--radius-lg/xl` → container so copy-in cards land correctly; bridge `--radius-sm` remapped off `calc(-2px)` to `var(--rounded-sm)`.
- **Copy-in supersede scope**: the restyled sensitive subset (button/card/input/table/skeleton/tabs/sidebar/select/dropdown-menu/dialog) is now "copy-then-locally-revised" — each carries a supersede header so a future `copy-shadcn-ui.ts` regen won't silently clobber; untouched components keep byte-identical discipline.
- **Motion tokens**: `--duration-fast/base/slow` + `--ease-*` with a token-level 1ms reduced-motion fold; raw `duration-200/300/500`/`ease-linear` faces all swept to token consumers (plan 58 REQUIRED sweep completed).
