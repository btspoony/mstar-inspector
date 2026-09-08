---
category: Changed
---

- **App settings page gains a GitHub identity card**: avatar, the App's name hyperlinked to its GitHub settings page, description, and App ID — served from GitHub metadata fetched per-App with a dashboard-local App JWT, cached in D1 with a 24h lazy refresh, and degrading gracefully when GitHub is unreachable.
- **Provider picker rebuilt**: the flat 214-entry dropdown is now a type-to-filter combobox (full keyboard operability), with a new "Common providers" group (Anthropic, OpenAI, Google Gemini, GitHub Copilot, xAI) ahead of the catalog templates; provider terminology is unified as "model provider" in Chinese. Runner/BYOK mechanics are unchanged.
- **Model-chain micro-UX**: the new-chain draft tab now live-relabels as you type the chain name, and the discard button sits inline with save as a visible outline control.
- **Insights stat sections are now charts**: findings by severity and by category render as count bars, weekly trends as a dual-series (reviews/findings) chart with a dated axis and legends — hand-rolled SVG, zero new dependencies, dark/light theme tokens.

<!-- CN -->
- **应用设置页新增 GitHub 信息卡**：展示头像、可点击直达 GitHub 设置页的 App 名称、描述与 App ID——数据由服务端以 per-App App JWT 从 GitHub 拉取，D1 缓存 + 24 小时惰性刷新，GitHub 不可达时优雅降级。
- **Provider 选择器重构**：214 项平铺下拉改为输入即筛选的 combobox（完整键盘可达），新增「常用提供方」分组（Anthropic、OpenAI、Google Gemini、GitHub Copilot、xAI）置于目录模板之前；中文术语统一为「模型提供方」。运行时/ BYOK 机制零变化。
- **模型链微交互**：新建链的 draft tab 标签随链名称输入实时更新；「放弃」按钮移入保存行，改为清晰可见的 outline 样式。
- **审查记录统计区图表化**：按严重程度/按类别统计改为计数柱图，每周趋势改为审查/发现双系列图（带日期轴与图例）——手写 SVG、零新依赖、适配明暗双主题。
