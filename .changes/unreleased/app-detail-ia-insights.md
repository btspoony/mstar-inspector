---
category: Added
---

- **App detail page with 应用设置/洞察 tabs**: `/dashboard/apps/:slug` hosts an identity header (slug, status, creator) over a two-tab shell — the settings content becomes the 应用设置 tab and a new 洞察 tab serves per-App insights; the legacy `.../settings` URL remains a deep link onto the settings tab, and Apps-list rows now open the detail route.
- **Per-App insights API**: `GET /dashboard/api/apps/:slug/insights/summary` serves the full insights aggregation scoped to one App (member-gated, creator-or-admin for the data face); the cross-App global endpoint is retired with no compat shim and answers 404, and the SPA's standalone global insights page is retired with it — insights now live on the App detail page.
- **Non-manager face narrowed**: a member who is neither creator nor admin receives an identity-only payload (public profile + creation time, `can_manage: false`) — the ops stores and settings payload stay manager-only, and the 洞察 tab renders for managers only.

<!-- CN -->
- **应用详情页（应用设置/洞察双 Tab）**：`/dashboard/apps/:slug` 由身份头部（slug、状态、创建者）与双 Tab 外壳构成——原设置内容成为「应用设置」Tab，新增「洞察」Tab 呈现按 App 的洞察视图；旧 `.../settings` URL 保留为设置 Tab 的深链接，应用列表行点击改为进入详情路由。
- **按 App 洞察 API**：`GET /dashboard/api/apps/:slug/insights/summary` 提供限定单个 App 的完整洞察聚合（成员可见，数据面限创建者/管理员）；跨 App 的全局端点退役，无兼容垫片，直接返回 404，SPA 独立的全局洞察页也随之退役——洞察现位于应用详情页。
- **非管理者身份面收窄**：非创建者/管理员的一般成员仅收到身份面载荷（公开档案 + 创建时间、`can_manage: false`）——运维数据与设置载荷仍仅管理者可见，「洞察」Tab 也仅对管理者渲染。
