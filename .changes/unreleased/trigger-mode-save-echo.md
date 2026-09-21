---
category: Fixed
---

- Fixed the App settings trigger-mode control holding a stale highlight after a successful save: the selection now echoes the new mode as soon as the save resolves (success means stored) instead of waiting for the background reload; failed saves still resync from the stored mode.

<!-- CN -->
- 修复应用设置的触发模式控件在保存成功后高亮滞留旧值的问题：保存请求成功返回（成功即已写入）后选择立即回显新模式，不再等待后台刷新；保存失败时仍会从已存模式重新同步。
