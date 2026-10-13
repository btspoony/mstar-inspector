---
category: Fixed
---

- **Trigger-mode selection echoes on save success**: the App settings control no longer holds a stale highlight after a successful save — the saved mode is highlighted as soon as the save resolves (success means stored) instead of waiting for the background reload; failed saves still resync from the stored mode.

<!-- CN -->
- **触发模式选择在保存成功后立即回显**：应用设置的触发模式控件不再在保存成功后高亮滞留旧值——保存请求成功返回（成功即已写入）后新模式立即高亮，不再等待后台刷新；保存失败时仍会从已存模式重新同步。
