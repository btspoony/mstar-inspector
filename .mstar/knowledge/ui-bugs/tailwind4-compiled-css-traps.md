---
module: spa / tailwind v4 styling (compiled-CSS failure classes)
date: 2026-09-10
problem_type: ui_bug
category: ui-bugs
severity: high
plan_id: 57-design-language-v2
tags:
  - tailwind-v4
  - css-first-config
  - theme-keys
  - dead-classes
  - preflight
  - built-css-pins
title: "Tailwind v4 compiled-CSS traps: dead utilities without theme keys + bare border currentColor"
symptoms:
  - "visual feedback missing/incorrect while component tests stay green"
  - "rules absent from (or wrong-valued in) dist/spa/assets/index-*.css"
root_cause: "Tailwind v4 generates utilities only from @theme keys (missing --color-* mapping = dead class); bare width-only border inherits border-color from currentColor under preflight"
resolution_type: code_fix
last_updated: 2026-09-12
source_plan: 57-design-language-v2
---

# Tailwind v4 compiled-CSS traps（编译产物两类静默失败）

## Problem

Tailwind v4 CSS-first 配置下，两 类「源码看着对、测试全绿、页面却没有样式」的静默失败在本仓真实发生（plan 57 QC F-001 Critical；plan 59 QC F-001 Warning）：

1. **无 theme key 的工具类 = 死类**。`hover:bg-primary-hover` 这类 utility 只会为 `@theme inline` 里声明过 `--color-primary-hover` 映射的 key 生成 CSS。`shadcn-theme.css` 在 `:root` 定义了 `--primary-hover` 变量、button.tsx 写了 class 字符串，但 `@theme inline` 缺 `--color-*-hover` 映射 → **零 CSS 输出**，主按钮 hover/active 反馈整体消失。测试 pin 断言的是「源码里 class 字符串存在」→ 持续绿灯，完全看不见。
2. **裸 `border`（width-only）的 border-color 落在 `currentColor`**。Tailwind preflight（`border: 0 solid`）+ 只写宽度/样式的 `border` utility → border-color 取继承文本色（`--card-fg` = gray-1000 全强度）。plan 59 的 SectionCard secondary 档写了 `shadow-none` 以为「无影 + 细边框」，实际渲染出全页最重的边框，层级强调反转。

## Symptoms

- 视觉反馈缺失/异常但组件测试全绿；QC diff 审查才发现。
- `dist/spa/assets/index-*.css` 里 grep 不到对应规则（死类）或规则值异常（currentColor）。

## What Didn't Work

- 源码字符串 pin（断言 className 存在）——对「utility 是否真的编译出 CSS」零鉴别力。
- 相信「变量定义了就会生效」——CSS 变量与 Tailwind theme key 是两层。

## Solution

- **修**：`@theme inline` 补 `--color-primary-hover: var(--primary-hover)`（同族三个 key）；`TIER_FACES.secondary` 补 `border-border`（桥接到 `--border` → `--gray-alpha-400`）。
- **防（pin 层）**：pin 必须断言 **theme coupling**（`@theme inline` 中映射 key 存在），而非源码 class 字符串；face pin 断言完整 class 串（如 `shadow-none border-border`）。
- **防（验证层）**：涉及新 utility 的任务，QA 在 `dist/spa/assets/index-*.css` grep 编译产物作 kill proof（本仓已多次用：`.hover\:bg-primary-hover:hover{...}`、`.font-\(weight\:...\)`）。

## Why This Works

Theme key 是 Tailwind v4 生成 utility 的唯一依据；编译产物 grep 直接检验最终事实，绕过「源码→编译」的静默断层。

## Prevention

- 新增任何 `bg-*`/`text-*`/`border-*` 语义工具类时，三件套一起改：`:root` 变量 + `@theme inline` 映射 + 消费 class，且 pin 落在映射层。
- 任何「仅声明宽度/样式的 border」必须有显式 border-color 面；review 时对 `border` 单独出现保持警惕。
- 验收含新 utility 的 plan，QA gate 固定带 built-CSS grep 项（017→018 已成惯例）。

## Extension（plan 64 / 020，2026-09-12）：opacity 修饰符的**成功**路径与编译形态

本文记录的是两类失败；plan 64 补齐了「theme key 存在时 opacity 修饰符如何工作」的实证面（AD-641 探针 + built-CSS kill proof）：

- **命名形 `bg-sidebar-primary/12`（有 `@theme inline` 键 `--color-sidebar-primary`）编译为** `background-color: color-mix(in oklab, var(--sidebar-primary) 12%, transparent)`，且编译器前置一行 `background-color: var(--sidebar-primary)` fallback + `@supports (color-mix(...))` 包裹——fallback 在前 = 无 color-mix 支持的浏览器吃全强度 var（与已上线 `hover:bg-sidebar-accent/40`、`.bg-muted/50` 同机制同暴露）。任意值形 `bg-(--sidebar-primary)/12` 输出逐字节一致。
- **data-attribute 变体的编译选择器是无引号形态** `[data-active=true]`（grep/pin 文本以 `.data-\[active\=true\]\:bg-sidebar-primary\/12[data-active=true]` 为准——带引号形式 grep 不到，plan 64 曾按引号形写锚点被 T1 实测纠正）。
- **档位裁决方法**：tint 显著度用 fill-vs-bg 对比 + active-vs-hover 色相/强度双维实测（dark `#22d3ee` / light `#0e7490` 双主题 token 分档），不要靠目测拍档位。
