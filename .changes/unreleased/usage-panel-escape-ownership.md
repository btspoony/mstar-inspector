---
category: Fixed
---

- **Escape stays with the usage panel you opened last**: a card's usage panel re-registers its document-level Escape listener only when it opens or closes, and reads the latest `onClose` through a ref — a parent re-render that hands the panel a fresh callback no longer moves it to the top of the open-panel stack, so Escape still dismisses the panel actually opened last.

<!-- CN -->
- **Escape 仍然关闭最后打开的那个用量面板**：卡片内的用量面板只在打开/关闭时重新注册文档级 Escape 监听器，并通过 ref 读取最新的 `onClose`——父组件重渲染带来新回调时，它不再被移到已打开面板栈的顶部，Escape 依旧关闭真正最后打开的面板。
