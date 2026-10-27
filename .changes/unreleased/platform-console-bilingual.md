---
category: Changed
---

- **The platform console is bilingual.** The operator console
  (`/_internal_admin/*`) resolves its header, nav, page copy and empty /
  loading / error states in the operator's language, driven by the same
  `boot.locale` the workspace shell uses. The locale switch is the same
  zero-JS form as the dashboard: one POST to `/dashboard/locale` re-GETs the
  document with the new cookie, and the preference cookie now spans both the
  dashboard and the console paths.
- **Flag toggles confirm first.** Clicking a server flag's switch opens a
  dialog naming the flag, the ON → OFF (or reverse) change and its effect
  before any write; only the confirm button sends the single `PATCH
  /api/flags`, followed by a short inline "Saved." note.
- **Console tables are searchable.** The Users and Workspaces tables gain a
  client-side search input with a shown / total counter — filtering runs over
  the already-loaded rows, with no URL state and no extra request.
- **The support-grant form sits in a real card.** The grant create form
  moves inside `CardHeader` + `CardContent` of its `SectionCard`, matching the
  Support / Settings page structure, instead of the previous ad-hoc wrapper.

<!-- CN -->
- **平台运维台支持中英双语。** 运维台（`/_internal_admin/*`）的页头、导航、页面文案以及
  空态 / 加载 / 错误态都按运维者所用语言呈现，与工作区外壳共用同一个 `boot.locale`。语言
  切换沿用了仪表盘的无 JS 表单：向 `/dashboard/locale` POST 一次后以新 Cookie 重新加载
  文档，偏好 Cookie 现在同时覆盖仪表盘与运维台路径。
- **开关旗标前先确认。** 点击服务器旗标的开关会先弹出对话框，写明旗标名称、
  开 → 关（或反向）的变更及其影响，然后才允许写入；只有确认按钮会发出唯一的
  `PATCH /api/flags`，随后显示一条短暂的“已保存”提示。
- **运维台表格支持搜索。** 用户与工作区表格新增客户端搜索输入框和“已显示 / 总数”计数——
  过滤在已加载的行内进行，不产生 URL 状态，也不发起额外请求。
- **支持授权表单放进真正的卡片里。** 授权创建表单移入 `SectionCard` 的
  `CardHeader` + `CardContent` 之内，与支持 / 设置页结构一致，不再使用临时的散装包裹。
