---
module: spa / hand-rolled svg chart primitives
date: 2026-09-08
problem_type: best_practice
category: best-practices
severity: low
plan_id: 56-insights-charts
tags:
  - svg
  - charts
  - zero-dependency
  - design-system
  - a11y
  - ssr-pins
  - layout
related_components:
  - src/spa/components/charts/layout.ts
  - src/spa/components/charts/BarChart.tsx
  - src/spa/components/charts/TrendChart.tsx
  - src/spa/pages/InsightsPage.tsx
---

# Hand-rolled SVG charts: pure-calc layout + render split, text coexistence, page-owned empty states

> **Status (2026-09-10, plan 63 / AD-621)**: the Insights charts now run on recharts (`best-practices/spa-recharts-token-charts.md`); the plan-56 hand-rolled pipeline (`layout.ts` + these components) is retired from the product. This doc is retained as the pattern reference for zero-dependency chart faces where a library is not adopted — the a11y floor, token discipline and pin hygiene sections remain governing guidance.

## Context

017-dashboard-ux plan 56 replaced three Insights list sections with charts. Decision G2 (user-locked): hand-rolled SVG, zero chart-library dependencies — data shapes are small (a few counts; ≤13 week points), bundle growth on the Worker-served SPA was a standing concern, and DESIGN.md's ops-console aesthetic favors plain geometry.

## Guidance

- **Three-file split per AD-563**: `layout.ts` (pure, deterministic scale/band/tick math — unit-testable without rendering) + `BarChart.tsx` / `TrendChart.tsx` (render only). No `Date.now`/`Math.random` in render; same props → same output (SSR-pin stable).
- **Colors = DESIGN.md tokens via inline style props** (never presentation attributes — see `ui-bugs/svg-var-presentation-attributes.md`). Semantic mapping lives at the *page* level (`SEVERITY_BAR_COLORS`), keeping components generic; unknown keys fall back to a neutral token with label+count still rendered.
- **Text counts coexist — the a11y floor**: charts never become the only information carrier. Bar-end value labels + axis ticks + (for trend) a page-level window-totals summary line; every chart svg carries `role="img"` + localized `aria-label`. Per-point data labels are not required when a page-level summary + axis cover the counts.
- **Empty-state ownership is the page's**: components return `null` on empty input; the page renders bilingual empty-state copy (and a heading-card-only face when there is no data at all). Document the hand-off in each component's JSDoc.
- **Guard the math edges**: zero/negative max, all-zero series, single point — `linearScale`/`niceTicks`/`bandScale` must never produce NaN or divide by zero; tick ladders use integer nice steps; >8 x-labels thin to every-other-week.
- **Pin discipline**: SSR pins assert resolved output (element counts, geometry values computed by hand from constants, off-tick count labels so bar-end text can't collide with axis ticks); a slice-scoped render helper isolates each chart's svg. Bite-check pins (mutate source → pin fails) before trusting a pin suite.

## Why This Matters

Gives the SPA a repeatable, dependency-free chart idiom that survives QC (deterministic, token-clean, a11y-floored) — and a record of the two review rounds that hardened it (color mechanism, geometry/centering pins), so the next chart starts from the hardened shape.

## When to Apply

Any new dashboard chart need with small static data shapes. Reach for a chart library only when interactive tooltips/zoom/pan become requirements (that would be a new decision, not an extension of this pattern).

## Examples

`src/spa/components/charts/` (layout/BarChart/TrendChart), `tests/spa/charts.test.ts` (component suite), `tests/spa/insights-page.test.ts` (page wiring + superseded plan-45 pins).


## AD-601 recalibration governance (iteration 018, 2026-09-10)

Palette rebase lesson (v0.2 → v0.3 Signal Cyan): because chart colors ride **frozen token names**, the entire "recalibration" pass verified the 700 steps survived byte-identical (values re-tuned only for grays/backgrounds) — semantic families (must-fix=red / should-fix=amber / nit=gray / trend dual-series) needed zero code change, only a re-verified contrast table (all fills ≥3:1 vs new card faces, both themes, recorded in DESIGN.md Appendix A). Governance rules added: brand accent must NEVER become a data-series color (brand expression only in chart card chrome); step re-picks are pin line-value updates, never pin-semantics supersedes; `layout.ts` is structure-frozen. Supersede ledger for presentation faces lives in the pin-file header (exactly 2 entries: page empty face → EmptyState; recurring-card wrapper → SectionCard secondary).
