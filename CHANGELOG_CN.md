# 更新日志

本文件是 [CHANGELOG.md](CHANGELOG.md) 的中文摘要，与英文版逐版本对应。

各版本小节在发版时由 [`.changes/`](.changes/README.md) 片段汇稿生成——片段格式与提交流程见该 README。

## [Unreleased]

## [1.0.0-alpha.2] - 2026-09-14

### Changed

- **应用设置页新增 GitHub 信息卡**：展示头像、可点击直达 GitHub 设置页的 App 名称、描述与 App ID——数据由服务端以 per-App App JWT 从 GitHub 拉取，D1 缓存 + 24 小时惰性刷新，GitHub 不可达时优雅降级。
- **Provider 选择器重构**：214 项平铺下拉改为输入即筛选的 combobox（完整键盘可达），新增「常用提供方」分组（Anthropic、OpenAI、Google Gemini、GitHub Copilot、xAI）置于目录模板之前；中文术语统一为「模型提供方」。运行时/ BYOK 机制零变化。
- **模型链微交互**：新建链的 draft tab 标签随链名称输入实时更新；「放弃」按钮移入保存行，改为清晰可见的 outline 样式。
- **审查记录统计区图表化**：按严重程度/按类别统计改为计数柱图，每周趋势改为审查/发现双系列图（带日期轴与图例）——手写 SVG、零新依赖、适配明暗双主题。

## [1.0.0-alpha.1] - 2026-09-07

### Added

- 新增 **GitHub Actions 发版链**：手动触发的 **Release prep** workflow 汇稿 changelog 片段、bump 版本面、验证并开启 `release vX` PR；merge 后触发 **Release** workflow，在 merge commit 上复验并打 annotated tag、创建双语 GitHub Release。发版与部署完全解耦——staging 自动化不受影响。
- 建立**双语 changelog 片段协议**（`.changes/`）：每次变更随代码提交 EN/CN 成对片段，发版时汇稿进 `CHANGELOG.md` / `CHANGELOG_CN.md`，并按已发布版本归档。
- **版本可见性**：`/healthz` 上报部署版本，仪表盘同步展示（单源 `package.json#version`），一致性由 `release:validate` 钉住。
- **发版↔部署对账**：release notes 记录部署的 Worker Version ID、Sandbox 镜像 digest 与 deploy run 链接（来自 deploy evidence）——绝不阻断 tag，证据缺失时显式标注。

### Baseline

- **以真实代理会话执行自动 PR 评审**：每次评审都在一次性 Cloudflare Sandbox 容器内运行多席位编码代理会话（克隆 → 评审 → 销毁），镜像内不烘焙任何密钥。
- **审查管线**：GitHub webhook 进入 Hono Worker 网关（per-App 路由 + 签名验证）→ Cloudflare 队列 → Sandbox 执行 → PR 上单条 upsert 评论，结构化 `mstar.review/v1` 发现存入 D1。
- **审查引擎**：`/amazing-pr-review` 多档位评审（quick / default / deep），含分类发现、行级评论、模型链降级与评审版本记录持久化。
- **运营硬化**：per-App Sandbox 镜像管理、固定 provider 允许清单、限流、Cron 监控与 fail-closed 审查语义——配置错误的 App 用自己的凭据大声失败，绝不波及他人凭据。
- **洞察能力**：发现指纹去重与 per-App Health 报告，将存量发现转化为复发与质量信号。
- **部署自动化**：GitHub Actions 全链——PR CI、staging 自动部署（secrets 注入、D1 迁移、部署后冒烟、镜像 digest 记录）。
- **Dashboard 平台化**：一套部署即可注册并运营任意多个 GitHub App，各自拥有访问控制、BYOK provider 密钥、模型链与运营面（暂停/恢复、设置、成员管理）。
- **Dashboard 体验**：en / zh-CN 双语 Vite SPA——shadcn 视觉地基、信息架构重设计、per-App Sandbox 镜像注册选择与反馈驱动的打磨。

