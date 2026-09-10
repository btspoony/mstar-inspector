---
module: spa / self-hosted brand typeface pipeline
date: 2026-09-10
problem_type: developer_experience
category: best-practices
severity: low
plan_id: 57-design-language-v2
tags:
  - fonts
  - geist
  - vite
  - unicode-range
  - font-display
  - budget-pin
title: "Dashboard self-hosted brand typeface: vite module graph + zh exclusion + budget/provenance pins"
last_updated: 2026-09-10
source_plan: 57-design-language-v2
---

# Dashboard 自托管品牌字体管线（plan 57 落地契约）

## Context

018 设计语言 v2 引入 Geist Sans。约束：零新 npm 依赖、Workers Assets 伺服、双语（zh 回退系统栈）、体积预算 ≤150KB。

## Guidance

- **资产管线**：vite `publicDir: false` → 字体必须走**模块图**：woff2 落 `src/spa/assets/fonts/`，`src/spa/styles/fonts.css` 写 `@font-face`，`url()` 由 vite 处理成 hashed `dist/spa/assets/*.woff2`（wrangler `directory: dist/spa` 伺服）。**不要**试图用 `public/`。
- **字重经济**：只 vendored 声明过的字重（400/500/600）；700 被显式排除（+46KB 会破预算且无消费者）。
- **zh 排除**：`@font-face` 的 `unicode-range` 只覆盖 latin/latin-ext 区段（U+0000-024F 等）——纯中文页面**一个字体字节都不下载**；测试按解码后的 range 区间逐码点探针（U+3000/U+4E00/U+FF0C 必须不在覆盖内）。
- **`font-display: swap`** 三个 face 全量；SSR 面（views.ts）只带 font-family 栈不带 @font-face（无 chrome 的 auth 面，系统栈回退是 documented 意图）。
- **防伪/溯源 pin**：测试断言 woff2 magic bytes + 总量 ≤150,000 字节；fonts.css 头注记录 vendored 文件 sha256（与上游 geist@1.7.2 逐字节一致的证据链：QC 重算 ↔ 头注 ↔ 上游比对三方一致）。
- **license**：OFL.txt 与二进制同目录 vendored（自托管=再分发，license 是硬前置）。
- **tabular-nums**：字体原生带 tnum 表；既有 `tabular-nums` 工具类直接生效，无需 per-page CSS——选型时把「原生 tnum」当硬指标。

## Why This Matters

字体是「提升最大、风险最低」的视觉一刀，但管线选择（模块图 vs public/、子集策略、预算治理）决定它是一次性资产还是长期负债。本仓的 pin 面（magic bytes/预算/range 探针/sha256）让字体回归可机器防守。

## When to Apply

- 换字体/加字重/扩子集时，全部按本管线与 pin 面执行。
- 任何新 woff2 进入仓库前：license + sha256 + 预算三件事先落。
