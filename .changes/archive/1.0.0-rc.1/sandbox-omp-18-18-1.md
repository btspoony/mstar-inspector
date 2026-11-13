---
category: Changed
---

- **OMP updated to 18.18.1**: the root and runner pins move from 18.17.0 to 18.18.1 with both lockfiles regenerated, and the sandbox image rebuilds. The regenerated vendored provider catalog changes only the version and extraction date; provider lists, model IDs and header hooks are unchanged.
- **The image's harness ref now matches its tag**: `harnessRef` still named the `v4.2.2` commit under a `4.2.3` version, so `REVIEW_SKILL_VERSION` read `4.2.3+98504a71` — a suffix no `v4.2.3` checkout contains. It now carries the `v4.2.3` commit `abf3167d`, and a contract test locks the Dockerfile's clone ref to it. Reviews recorded before this change keep their historical suffix.

<!-- CN -->
- **OMP 升级至 18.18.1**：根项目与 runner 的固定版本从 18.17.0 升至 18.18.1，两个锁文件均已重新生成，沙箱镜像也会重建。重新生成的固化提供方目录仅更新版本与提取日期；提供方列表、模型 ID 和请求头钩子均未改变。
- **镜像的 harness ref 与其 tag 对齐**：`harnessRef` 在 `4.2.3` 版本下仍指向 `v4.2.2` 的提交，导致 `REVIEW_SKILL_VERSION` 读作 `4.2.3+98504a71` —— 该后缀不对应任何 `v4.2.3` 检出。现已改为 `v4.2.3` 的提交 `abf3167d`，并新增契约测试把 Dockerfile 的克隆 ref 锁定到它。此改动之前记录的审查保留其历史后缀。
