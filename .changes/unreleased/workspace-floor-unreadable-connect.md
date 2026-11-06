---
category: Fixed
---

- Connecting a GitHub App no longer reports a generic database rejection when the workspace's default score floor cannot be read: the connect page names the unreadable workspace setting, states that nothing was stored, and links to the workspace settings page to repair it before resubmitting. A genuine database failure keeps its own copy.

<!-- CN -->
- 当工作区的默认评分下限无法读取时，连接 GitHub App 不再显示笼统的“数据库拒绝了写入”：连接页面会指明无法读取的是工作区设置、说明未存储任何内容，并链接到工作区设置页面，修复后重新提交即可。真正的数据库故障仍保留原有提示。
