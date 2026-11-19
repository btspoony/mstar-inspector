---
category: Fixed
---

- Reset provider model sync previews and notices when the dialog closes, requiring a fresh successful preview before confirmation after reopening and ignoring previews completed for a closed dialog.
- Keep the dialog open while a sync write is pending so failures remain visible; preview fetches can still be dismissed.

<!-- CN -->
- 修复供应商模型同步对话框关闭后保留旧预览和提示的问题；重新打开后须成功获取新预览才能确认，已关闭对话框的延迟响应不会启用确认。
- 同步写入期间保持对话框打开，确保失败提示不会丢失；获取预览期间仍可关闭对话框。
