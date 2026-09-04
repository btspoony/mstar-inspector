---
module: spa-settings-page
date: 2026-09-04
problem_type: best_practice
category: best-practices
severity: medium
applies_when:
  - "Settings/dashboard SPA pages where mutations trigger a data refetch"
  - "Any SPA page with a global loading gate that swaps the whole view"
  - "Designing form flows that must survive a failed verification"
plan_id: 38-provider-configuration-flow
related_components:
  - "39-app-detail-model-chains (contract reused by chain/seat ops)"
  - "40-apps-default-polish (delete branch reload:false exception)"
tags:
  - spa
  - react
  - reload
  - forms
  - state-preservation
  - wcag
---

# SPA op-refresh must not trip the page loading gate (background reload contract)

## Context

`SettingsPage` 是多卡片配置面（runtime image、configured providers、chain tabs、seats、ops）。每个 op（verify key、save chain、save roles、remove、delete）成功/失败后都要 refetch。plan 38 曾把「失败后保留已输入 key 与打开的 Add 面板」写成契约，但 `load()` 每次 refetch 都把 `state` 翻成 `"loading"`，而视图只在 `"ok"` 渲染——**每次 op 后整棵卡片树被卸载**：面板关闭、输入丢失、success 回调落在已卸载实例上（静默 no-op）。失败看起来"还行"只是因为 remount 恰好复位。QC Warning 抓到后修复为 background reload 契约（plan 39/40 沿用）。

## Guidance

1. **单一加载门，两条刷新路径**：只有**前台**加载（首次 mount、真正的硬导航）允许进入 loading 门；**op 触发的 refetch 一律 background**——数据原地替换，组件树不动。实现：`load({ background = false } = {})`，`if (!background) setState("loading")`；所有 op handler 传 `{ background: true }`。
2. **background 失败不许进门**：background 刷新失败走通知通道（PageNotice），**不得**翻 `"error"`/`"loading"`——否则一次瞬时 refetch 失败就重现"整页卸载"。
3. **失败保态、成功显式收尾**：verify 失败 → 面板保持打开、已输入值保留、结构化错误展示；成功 → 由 op 的完成回调**显式**关闭/重置（此时回调运行在挂载实例上，真正生效）。
4. **豁免要最小且有据**：Delete App 的成功分支用 `reload: false`——软删 App 的 settings GET 按 404 契约必败，refetch 只会用 "Load failed." 盖掉成功通知。豁免必须单点（源码 pin 把 `reload: false` 的属性形态限定为 1 处，防止其它 op 静默丢刷新）。
5. **契约必须钉进测试**：source-contract 断言 background 标志传播到每个 op、前台 mount 才进门、background 失败走通知、成功才显式关闭。没有 DOM runner 也要锁机制，不锁样式。

## Why This Matters

「loading 门 + 全视图替换」是最常见的 SPA 结构，而 op-refresh 需要的恰恰相反：**局部、保态、可失败**。这个 bug 的危害形态是契约性倒退——行为看起来正常（成功路径 remound 复位），只有失败路径的用户可感损伤（输入丢失），单测全绿。

## When to Apply

- SettingsPage（或同构配置页）新增任何 op / 卡片时
- 评审「失败后保留 X」类需求时——先检查 refetch 是否翻 loading 门
- 给 PageNotice 加语义角色：success/warn `role="status"`（错误保持 `role="alert"`，WCAG 4.1.3）；live-region 与内容同时挂载时部分 SR 可能不播报——浏览器验收要覆盖

## Examples

- 机制：`src/spa/pages/SettingsPage.tsx` `load({ background })`、六个 op 调用点、`PageNotice.tsx` role 分支
- 测试：`tests/spa/settings-layout.test.ts`（background 契约 pin、`reload: false` 单点 pin、notice role pin）
- 已知 accepted 限制：spaClick 双副本待合并；post-delete 页面上继续操作会看到 raw "unknown app"（预存模式）
