---
category: Added
---

- **Workspace settings page.** The sidebar gains a **Settings** entry (`/dashboard/<ref>/settings`) carrying the workspace URL (slug) rename, moved out of the App settings tab so there is one editor rather than two. The rename stays owner-only: a non-owner sees the refusal copy instead of a form whose save would 403. The sidebar also spans the full viewport height. `settings` is now a reserved workspace slug, so a workspace already slugged `settings` must be reached as `/dashboard/<id>/…` and renamed — a rename is not a redirect.

<!-- CN -->
- **工作区设置页。** 侧栏新增 **设置** 入口（`/dashboard/<ref>/settings`），承载工作区 URL（slug）改名，并从应用设置页迁出，避免两个编辑入口。改名仍然只允许所有者：非所有者看到的是拒绝说明，而不是提交后才 403 的表单。侧栏同时改为撑满视口高度。`settings` 现已成为保留的工作区 slug：已经用 `settings` 作 slug 的工作区需要通过 `/dashboard/<id>/…` 访问并改名——改名不会重定向旧链接。
