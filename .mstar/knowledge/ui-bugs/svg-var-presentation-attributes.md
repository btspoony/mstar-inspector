---
module: spa / svg chart components (token colors)
date: 2026-09-08
problem_type: ui_bug
category: ui-bugs
severity: medium
plan_id: 56-insights-charts
tags:
  - svg
  - css-vars
  - presentation-attributes
  - style-props
  - dark-theme
  - tokens
  - charts
related_components:
  - src/spa/components/charts/BarChart.tsx
  - src/spa/components/charts/TrendChart.tsx
symptoms:
  - chart bars/text render black or invisible in dark theme while SSR markup contains the intended var() strings
  - no console error; light theme may work by fallback luck
  - string-based SSR pins pass despite the dead paint
root_cause: "SVG presentation attributes are parsed as SVG values, not CSS declarations, so var() substitution is not guaranteed (open SVGWG issue; documented black-fill fallbacks; some engines reject var() in attribute-value contexts)."
resolution_type: code_fix
---

# SVG token colors must ride inline style props, not presentation attributes

## Problem

Plan 56's first chart implementation set token colors as SVG presentation attributes: `fill="var(--red-700)"`. QC flagged the mechanism: putting `var()` inside presentation attributes is not a sanctioned combination (open SVG working group issue; SVG 2 notes presentation attributes are parsed as SVG values, not CSS declarations, with documented black-fill fallbacks — and some engines reject `var()` in attribute-value contexts outright). Failure face: bars/text silently render black or invisible in the dark theme — exactly the face the SSR string pins could not catch, because the markup *string* looks correct either way.

## Symptoms

- Markup/SSR output contains the intended `fill="var(--token)"` strings (pins pass).
- Live dark theme: chart bars or text render black/invisible; light theme may work by fallback luck.
- No console error.

## Root Cause

Presentation attributes are an attribute-value defaulting mechanism, not a full CSS declaration surface; `var()` substitution is only guaranteed where CSS declarations are parsed (style sheets and inline `style`).

## What Didn't Work

Asserting the attribute string in tests — it validates the markup, not the paint. The repo's SSR-pin idiom cannot distinguish a working `var()` face from a dead one.

## Solution

Inline style props: `style={{ fill: "var(--red-700)" }}` (React serializes to `style="fill:var(--red-700)"`, a real CSS declaration where `var()` is defined). Applied to all color-bearing elements in `BarChart.tsx`/`TrendChart.tsx`; pins updated to assert the `style="fill:var(--token)"` face, which fails loudly on serialization drift.

## Why This Works

Style attributes are parsed as CSS declarations, where custom-property substitution is universally defined. Geometry attributes (`width`, `x`, …) are unaffected — only color/paint properties need this treatment.

## Prevention

- Any new SVG code that colors from DESIGN.md tokens uses style props for `fill`/`stroke`/`color`; presentation-attribute `var()` is a review red flag.
- The no-raw-hex source pin stays as the token-SSOT guard; consider a lint/pin forbidding `(fill|stroke)="var(` in `src/spa` (grep: zero matches is the current invariant, verified at plan-56 QA).

## Update (2026-09-10, plan 63)

The remedy above (inline style props) covers **hand-authored** SVG. When a chart library emits `fill`/`stroke` as presentation attributes on your behalf (recharts serializes props via `filterProps` → attributes), you cannot inject style props per element — the remedy extends: **author CSS class rules beat presentation attributes in the cascade**, so route library elements through `className` and declare `.chart-* { fill: var(--token) }` in a stylesheet. Same root cause, second remedy face. Full pipeline (version line, probe idiom, pin discipline): `best-practices/spa-recharts-token-charts.md`.
