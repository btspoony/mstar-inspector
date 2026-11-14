---
category: Fixed
---

- **The dashboard document speaks the language it is written in**: a `zh_CN` workspace shell now declares `<html lang="zh-CN">` and a localized page `<title>` instead of shipping Chinese copy under `lang="en"`, so screen readers use the right speech engine and browser tabs distinguish pages (WCAG 3.1.1, 2.4.2).
- **The sidebar is a navigation landmark, and the shell has a skip link**: the left navigation is now reachable as a named `navigation` region, and the first focusable control jumps straight to the page content.
- **A client-side navigation announces itself**: moving between Apps, Members and Settings rewrites the document title and moves focus into the content region, so keyboard and screen-reader users learn that the page changed.

<!-- CN -->
- **仪表盘文档如实声明自己的语言**：`zh_CN` 工作区外壳现在声明 `<html lang="zh-CN">` 并输出本地化的页面 `<title>`，不再把中文界面标记为英文，读屏软件因此用对发音引擎，浏览器标签也能区分页面（WCAG 3.1.1、2.4.2）。
- **侧栏成为导航地标，外壳提供跳转链接**：左侧导航现在是一个带名称的 `navigation` 区域，第一个可聚焦控件直接把焦点送到页面内容。
- **客户端导航会播报自己**：在应用、成员、设置之间切换会更新文档标题并把焦点移入内容区域，键盘与读屏用户因此知道页面已经变化。
