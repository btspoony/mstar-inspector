---
module: dashboard / visual foundation (shadcn + Tailwind v4 on Worker-served Vite SPA)
date: 2026-09-04
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

- **Bridge, don't replace**: existing `tokens.css` custom properties stay the source of truth; a `shadcn-theme.css` layer maps shadcn CSS variables (`--background`, `--foreground`, …) onto tokens via `@theme inline`. shadcn components then inherit the project palette. Dark is primary (`prefers-color-scheme`), light declared in parallel; `DESIGN.md` documents the mapping table (L2 completeness).
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
