---
module: spa / recharts chart layer (token discipline + SSR pin face)
date: 2026-09-10
problem_type: best_practice
category: best-practices
severity: medium
plan_id: 63-insights-chart-lib
tags:
  - recharts
  - charts
  - ssr-pins
  - css-vars
  - tokens
  - react-19
  - bundle-budget
  - static-render
related_components:
  - src/spa/components/charts/BarChart.tsx
  - src/spa/components/charts/TrendChart.tsx
  - src/spa/components/charts/charts.css
  - tests/spa/charts-recharts.test.tsx
---

# Recharts on the Worker-served SPA: version line, SSR pin face, CSS-class token delivery

## Context

019-visual-feedback plan 63 replaced the hand-rolled SVG chart layer (plan-56 paradigm, `spa-hand-rolled-svg-charts.md`) with recharts after the user judged the hand-rolled charts visually insufficient. The migration hit a hard STOP on the obvious version line and survived only because a probe task ran before the pin was locked. Everything below is verified against recharts **2.15.4** (the pinned line) on React **19.2.7**.

## Guidance

- **Version line: pin 2.15.x, never 3.x (as of 2026-09).** recharts 3.10.1 renders an **empty wrapper div under `renderToStaticMarkup`** — the redux store never initializes server-side (`RootSurface` returns null); upstream issues #5997 (open) / #6139 (dup), maintainer position: SSR "never explicitly supported", no ETA. Reproduced across 6 render variants (renderToStaticMarkup/renderToString × Bar/Line/Area × animation on/off ± axes). The 2.x line's peers already include `^19` — the "2.x doesn't support React 19" premise checked false. Any bump to 3.x must re-verify the SSR pin face first; expect it to fail.
- **visx `@visx/xychart` is not an SSR-pin fallback either**: static output is only the transparent hit-rect. Only visx low-level primitives (`@visx/shape`/`axis`/`scale`) render statically, which forfeits the out-of-box tooltip/axis surface — that is hand-rolled assembly again.
- **Probe before you pin.** A scratch `renderToStaticMarkup` probe (final-state geometry present? real `<rect>` coordinates? tick text flows?) gated the dependency commit. It converted a would-be mid-migration disaster into a one-task STOP + architect re-decision. Keep the probe as a permanent regression pin: it kills the 3.x empty-wrapper face (`<recharts-surface>` + viewBox + `<rect>` with numeric x/y + tick text) and the zero-height animation-frame face.
- **Token colors ride CSS class rules, not props — and this beats presentation attributes.** recharts serializes `fill`/`stroke` props as SVG **presentation attributes** (verified in `Rectangle.js`: `filterProps` → attributes, not inline styles). `var()` in presentation attributes is the known dead-paint trap (`ui-bugs/svg-var-presentation-attributes.md`), but you cannot use inline style props through recharts props either. The escape hatch: **author CSS rules beat presentation attributes in the cascade** — route colors through `className` on `<Bar>`/`<Cell>`/axis chrome and declare `.chart-fill-* { fill: var(--token) }` in a plain stylesheet (scoped under a wrapper class for axis internals). Map semantic keys → classes through a **closed vocabulary map** with a documented neutral fallback; keep the page-level semantic mapping (`SEVERITY_BAR_COLORS`) so components stay generic. Re-grep the built CSS for the class rules as the kill-proof.
- **Pin-path discipline**: fixed numeric `width`/`height` (fluid scaling can ride a `style={{width:"100%",height:"auto"}}` wrapper — recharts spreads consumer style last, viewBox preserved; `ResponsiveContainer` stays banned from render paths and needs no jsdom to prove); `isAnimationActive={false}` on every series (SSR animation frames are empty geometry); named/aliased imports only (tree-shaking); recharts-touching test files must be `.tsx` (React 19 types reject recharts 2.x class components through `createElement` overloads — TS2769).
- **A11y forwarding is real but pin it**: recharts forwards `role`/`aria-label` onto the svg and renders `title` as an svg `<title>` child (`Surface.js`) — but only a positive `<title>` pin makes that contract load-bearing (it survives until someone drops the prop; mutation-check your pins).
- **Bundle accounting**: measure per-chunk `gzip -6` (reconcile against vite's log figure once, then keep one method); state the budget as an **increment cap** against a named baseline commit, not an absolute total. recharts 2.15.4 cost this SPA +94,734 B gzip JS against a +150 KB cap. Chart pins couple to recharts-internal class names (`recharts-rectangle`, …) — a version bump must re-verify the chart pin suite.

## Why This Matters

The obvious install (`recharts@3`) is the trap: it installs cleanly, type-checks cleanly, and renders nothing server-side — discoverable only if the test surface renders charts at all. This repo's SSR-string pin idiom is exactly the consumer that dies. The probe-first gate, the 2.15.x line decision, and the CSS-class token delivery together make the library adoption compatible with the repo's no-raw-hex, dual-theme, SSR-pin invariants.

## When to Apply

Any SPA chart work under `src/spa/components/charts/`; any recharts version bump; any new chart consumer that wants token colors or a tooltip; any future re-evaluation of the chart-library line (start from the probe, not from npm's latest tag).

## Stacked-chart addendum（plan 65 / 020，2026-09-12）

plan 65 把两卡换成按天堆叠柱图（`StackedBarChart.tsx`，BarChart 聚合组件退役），以下纪律在 2.15.4 上实测成立：

- **`stackId` 堆叠是同一 Bar 原语**——SSR 静态渲染 pin 面（`renderToStaticMarkup`）直接可用：pin「自底向上相邻段 y+h 闭合」+「各段高度与计数成比例」即可防堆叠序/计数回归；每 `Bar` 仍 `isAnimationActive={false}`。
- **图例用 plan-56 HTML 行（`.chart-legend` + `.chart-swatch-*` twins），不用 recharts `<Legend>`**——swatch 色需要 token class 面，recharts Legend 是自带定位 wrapper 的未样式化面，与固定高度布局叠加徒增 pin 脆弱性。
- **hostile-label escape pin 面扩大**：分类是 open-set wire 字符串（schema `z.string().optional()`），现在到达 HTML 图例 span + tooltip `name` attr + 轴 tspan 三个面——escape pin 必须覆盖三者（React 默认转义仍生效，pin 是防回归的回归护栏）。
- **退役聚合组件时的连带面**：删除组件会连带删掉它的 describe 块——charts.css 填充规则绑定 pin、hostile-label escape pin、tooltip token styling pin、轴 thinning pin 都可能藏在里面；退役前盘点「该 describe 还 pin 了什么」，逐项重述到新组件（plan 65 QC 三席各自抓到一两条，fix 轮才清干净）。
- **文字计数底线在堆叠下换脸**：per-bar LabelList 退役（堆叠段内文字不可读），aria/文字并存底线由 `<title>` 正 pin + y 轴刻度文字 + 页级汇总行 + tooltip 承接——pin 这四者而非段落计数。
- **图例零过滤**：series 图例项按窗口内总量 > 0 过滤（`seriesWithFindings`），轴/堆叠保持全桶时间连续性——「图例仅列窗口内出现分类」的契约措辞落地在页层。
- **组件 props 与 wire 类型对齐**：闭包词表 `series: {key,label,fillClass}[]` + 页层持语义映射；组件内部 `DistributionBucket` 类型与 `data.ts` wire 守卫保持同形（可选字段松弛会被 review 抓）。
- **已知残余**：`formatBucketDateLabel` 与 TrendChart 的 formatter 逐字节重复——被「TrendChart byte-identical」锚点强制，动 TrendChart 时才合并。
