---
category: Changed
---

- **Dark theme is now the deterministic default**: the SPA no longer follows the OS `prefers-color-scheme` light fallback — the effective theme is the stored navbar-toggle choice, or dark when unset; the document body now paints the theme canvas so no unstyled gap surrounds the app. Stored toggle choices still win.

<!-- CN -->
- **深色主题成为确定性默认**：SPA 不再跟随操作系统的 `prefers-color-scheme` 浅色回退——有效主题取导航栏切换的已存选择，未设置时即为深色；文档 body 现在会绘制主题画布，应用四周不再出现无样式留白。已存的切换选择仍然优先。
