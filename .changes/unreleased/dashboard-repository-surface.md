---
category: Changed
---

- **The repository surface is a table sorted by the newest review, with a 待安装 filter**: the workspace's repositories list as rows — name, App, status, last review — newest review first, and a segment counts the rows still awaiting install so an operator can narrow to them. Adding a repository is a three-step flow, the installed-roster face names each installation's account, id, last sync and state again, and the chain editor's row controls sit on one right-aligned line with the seat rows compacted.
- **The delivery tab loads before it claims an empty state**: it shows its own loading face while the first read is in flight instead of rendering "no deliveries" and then replacing it.

<!-- CN -->
- **仓库页改为按最近审查倒序的表格，并带「待安装」筛选**：工作区仓库以行呈现——名称、App、状态、最近审查——最近审查在前；分段控件统计仍待安装的行，便于运营者只看这些。添加仓库改为三步流程；已安装名册重新列出每个 installation 的账号、ID、最近同步与状态；模型链编辑器的行操作靠右对齐，席位行更紧凑。
- **投递页先显示加载态，而不是先报空**：首次读取进行中时显示自己的加载面，不再先渲染「没有投递」再替换。

