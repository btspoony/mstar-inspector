---
category: Fixed
---

- **The model-chain editor's action row anchors to the panel's trailing edge** (`I-000647`). The picker, 加入模型链, 保存模型链 and the draft's discard share one right-aligned wrapping row, so the controls can no longer run past the container's edge at any width and 保存模型链 stays the row's primary face.
- **A seat and the chain it runs on are one row** (`I-000648`). 席位链 renders one identity-plus-select row per seat, separated by hairlines, with the role caption on the identity side; 保存席位链 is the section's own trailing action instead of trailing the last seat. The control's behaviour is unchanged.
- **The 投递状态 tab no longer reports "no deliveries" while its first read is in flight** (`I-000649`). The table, its empty state and the pager range appear only once a page resolves; the in-flight frame shows the loading line alone.

<!-- CN -->
- **模型链编辑器的操作行锚定在面板右边缘**（`I-000647`）。选择器、「加入模型链」、「保存模型链」与草稿的「放弃」共用一行、靠右并允许换行，因此控件在任何宽度下都不会越过容器边缘，「保存模型链」仍是该行的主操作。
- **席位与其运行的链合并为一行**（`I-000648`）。「席位链」为每个席位渲染一行「身份 + 选择器」，以细分隔线分隔，角色说明文字留在身份一侧；「保存席位链」成为该区块自己的尾部操作，而不再跟在最后一个席位之后。控件行为不变。
- **「投递状态」不再在首页读取尚未返回时声称「没有投递」**（`I-000649`）。表格、空状态与分页区间只在页面数据返回后出现；请求进行中只显示加载中提示。
