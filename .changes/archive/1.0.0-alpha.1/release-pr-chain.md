---
category: Added
---

- Added a **GitHub Actions release chain**: the manually-triggered **Release prep** workflow assembles changelog fragments, bumps the version surface, validates, and opens a `release vX` PR; merging it triggers the **Release** workflow, which re-verifies on the merge commit and cuts an annotated tag plus a bilingual GitHub Release. Releasing is fully decoupled from deploying — staging automation is untouched.
- Established the **bilingual changelog fragment protocol** (`.changes/`): every change ships a fragment with paired English / Chinese bullets, assembled into `CHANGELOG.md` / `CHANGELOG_CN.md` at release time and archived per released version.
- **Version visibility**: `/healthz` now reports the deployed version and the dashboard displays it (single source `package.json#version`), with consistency pinned by `release:validate`.
- **Release ↔ deploy reconciliation**: release notes record the deployed Worker Version ID, sandbox image digest, and deploy run link from deploy evidence — never blocking the tag, and stating explicitly when evidence is missing.

<!-- CN -->
- 新增 **GitHub Actions 发版链**：手动触发的 **Release prep** workflow 汇稿 changelog 片段、bump 版本面、验证并开启 `release vX` PR；merge 后触发 **Release** workflow，在 merge commit 上复验并打 annotated tag、创建双语 GitHub Release。发版与部署完全解耦——staging 自动化不受影响。
- 建立**双语 changelog 片段协议**（`.changes/`）：每次变更随代码提交 EN/CN 成对片段，发版时汇稿进 `CHANGELOG.md` / `CHANGELOG_CN.md`，并按已发布版本归档。
- **版本可见性**：`/healthz` 上报部署版本，仪表盘同步展示（单源 `package.json#version`），一致性由 `release:validate` 钉住。
- **发版↔部署对账**：release notes 记录部署的 Worker Version ID、Sandbox 镜像 digest 与 deploy run 链接（来自 deploy evidence）——绝不阻断 tag，证据缺失时显式标注。
