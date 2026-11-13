# 更新日志

本文件是 [CHANGELOG.md](CHANGELOG.md) 的中文摘要，与英文版逐版本对应。

各版本小节在发版时由 [`.changes/`](.changes/README.md) 片段汇稿生成——片段格式与提交流程见该 README。

## [Unreleased]

## [1.0.0-rc.1] - 2026-11-13

### Added

- **应用设置中的单 key 用量操作**：每一行已存储的模型提供方密钥新增「用量」操作，用该密钥请求提供方自己的配额端点，并在一个对话框中同时回答两件事——该密钥是否仍被接受，以及额度还剩多少：窗口型的剩余占比与重置时间，或账户级余额（标记为共享，避免多把 key 共用同一额度池时被误读为各自独立的额度）。覆盖范围限定在配额端点接受纯 API Key 的提供方：Command Code、OpenCode Go、Z.AI/智谱、MiniMax token plan、ClinePass、Synthetic、Umans、Charm Hyper、Kimi for coding，以及 Cursor（仅其 API Key 用量路由）。仅支持 OAuth 的用量面不在覆盖范围内，不显示用量操作——Cursor 的 OAuth 用量面同样如此；没有配额端点的提供方也不显示。对话框在打开时探测，其「刷新」控件会再次请求提供方——不做缓存，每次查看反映的都是该时刻密钥的状态。
- **应用详情页（应用设置/洞察双 Tab）**：`/dashboard/apps/:slug` 由身份头部（slug、状态、创建者）与双 Tab 外壳构成——原设置内容成为「应用设置」Tab，新增「洞察」Tab 呈现按 App 的洞察视图；旧 `.../settings` URL 保留为设置 Tab 的深链接，应用列表行点击改为进入详情路由。
- **按 App 洞察 API**：`GET /dashboard/api/apps/:slug/insights/summary` 提供限定单个 App 的完整洞察聚合（成员可见，数据面限创建者/管理员）；跨 App 的全局端点退役，无兼容垫片，直接返回 404，SPA 独立的全局洞察页也随之退役——洞察现位于应用详情页。
- **非管理者身份面收窄**：非创建者/管理员的一般成员仅收到身份面载荷（公开档案 + 创建时间、`can_manage: false`）——运维数据与设置载荷仍仅管理者可见，「洞察」Tab 也仅对管理者渲染。
- **增量审查轮次**：当本 PR 上一个已审查的 head 是新 head 的祖先（GitHub `compare` 返回 `ahead`）时，各席位
  只审查 `since <base>` 的增量而非整个 PR，评论头部以 `· since <sha7>` 标注。既有 finding 的证据目录仍基于完整
  PR diff 构建；其它 compare 结论（或 force-push 造成的 404）继续走全量 diff 轮次。
- **完整审查报告**：当本轮能抓取到 PR 上下文时，发布的评论现在携带 envelope 无法承载的内容——
  `**What this PR does**` 概述、机器生成的 `### Revalidated findings` 表、`### Linked-issue AC`、
  `### ✅ Verified`、`### 🗑️ Considered & rejected` 与可折叠的 `## 🛠️ Plan to fix`。这些内容走独立文档
  （`mstar.report/v1`），由有界报告席位写出，Worker 失败即拒绝校验，缺失时统一渲染为 `none`。
  `deep` 档位永远不发布该文档：队列窗口在预留本档位 runner 自身预算后已没有余量留给 PR 上下文抓取，因此
  `What this PR does` 直接省略，`Linked-issue AC`、`Verified`、`Considered & rejected` 与 `Plan to fix`
  一律发布 `none`。报告文本无法折叠、围栏或改写评论结构：标题、分隔线、代码围栏行与原始 HTML
  在插入前均已中和，修复计划始终以代码块围栏呈现。
- **报告绑定到本次审查的 head**：独立文档携带被审查的 `headSha`，由 runner 从 envelope 写入（而非席位自己），
  Worker 拒绝任何绑定到其它 head 的文档——席位被跳过时遗留在容器里的报告不会再冒充后续一次审查。席位定义缺失
  或 envelope 无 head 时降级为 `none`，绝不会让审查失败。
- **既有 finding 只渲染一次**：正文 `### Revalidated findings` 段承载完整的 §7.10 呈现（覆盖行、逐行处置、
  证据、thread 与展示上限），因此带报告正文只发布一张既有 finding 表，而不再在下方折叠出第二份。
- **增量基线与报告上下文均有界**：同一 installation 下的两个 App 不会共用增量基线——只有本 App 自己上一个已
  审查的 head 才能界定增量；当本轮剩余的墙钟时间不足以支付 PR 上下文抓取成本时，该步骤直接跳过并打一条具名
  日志，慢沙箱因此无法把审查窗口耗在叙述上。抓取门禁同时预留本档位 runner 自己的预算，因此“装得下抓取却会
  挤掉付费运行”的情况同样跳过。若合法增量基线的 `base...head` 确实为空，则视为无可审查内容：本次投递打一条
  结构化日志后直接 ack，不发布新评论、不写 `context_incomplete` 行，其 Check 继承被审查 head 的 gate 结果
  （按当前 gate 得出 `success`/`failure`，并写明该 head 及其 verdict/score），而不是以独立的 `neutral` 结束——
  空提交无法替换被审查 head 那个失败的必需检查；基线结果不可读（行缺失、envelope 无法解析、缺少评分）时
  检查直接失败关闭，而不是保持 `neutral`。报告文档
  的字节上限由各字段的字符预算推导而来，任何满足预算的文档都不可能被字节门拒绝。
- **`may-fix` 合并级别**：engine 4.2.2 在 `should-fix` 与 `nit` 之间新增的 finding 级别现在覆盖所有按级别呈现的层——审查 tally 与 finding 截断排序按它排序、PR 详情的 findings 筛选提供它、insights 分布为它补零、严重度图表把它作为独立系列绘制——因此产出 `may-fix` 的审查不再丢失 finding，也不会让分布失真。
- **Pull requests 账本工具栏**：App 的 Pull requests 标签新增仓库筛选与刷新控件。筛选在服务端于账本的有界窗口内执行，因此其 PR 全部落在最新 200 行之后的仓库在选中后依然可达；选项集合是该 App 全部去重仓库，且永不随当前选择收窄。
- **真实 App 头像与可用性徽章**：App 安装面板改为显示真实的 GitHub 头像（缓存列，或按 App id 派生的地址；仅 CDN 命中失败时才回退到 octocat 占位图），不再使用通用 GitHub 标记；Installed 标签的表格新增可用性列，按存储的 owner 允许名单判定每个安装——名单关闭时一律有效，开启时仅名单内账户有效。
- **发布门控的生产环境**：**非预发布**的 release 现在会部署第二个 Worker——`mstar-inspector-production`，服务地址 `https://inspector.mstar.page`——拥有独立的 D1、KV namespace、队列对（`review-queue-prod` / `review-dlq-prod`）与容器应用，与暂存 Worker `mstar-inspector`（`mstar-inspector.42ch.dev`）不共享任何资源；暂存环境仍随每次 `main` 推送部署。该部署由发布工作流在 tag 上**显式派发**生产工作流启动——用工作流自身 `GITHUB_TOKEN` 发布的 Release 不会触发 `release: published`，因此该 Release 的部署由这次显式派发启动，且发布 job 需要 `actions: write` 权限（由人工手动发布的 Release 则通过保留下来的 `release: published` 触发器部署，其 job 级 tag guard 会跳过预发布 tag）。自动化链路永不把预发布（tag 含 `-`）派发到生产；人工按 tag ref 执行 `workflow_dispatch` 则**可以**部署预发布——首次上线正是如此（上线所用 tag 必须在本改动合入之后创建：更早的 `v1.0.0-alpha.2` 早于本工作流），回滚也按同样方式派发（`gh workflow run deploy-prod.yml --ref <tag>`）。生产工作流不接受 `ref` input，因此运行所跑的 tag 就是它部署的 tag，运行 ref 即实际部署的检出（非 tag ref 会在任何变更前被拒绝）。
- **发布证据指向生产运行**：每个 GitHub Release 的 *Deploy evidence* 区块改为解析该 tag 对应的生产部署运行，而不再是暂存运行。
- **生产环境上线文档**：`docs/deploy.md` 新增「Production environment」章节（两条部署路径、一次性 Cloudflare + GitHub `production` environment 手册——采用仅允许 `v*` tag 的部署策略，因为仅分支策略会拒绝 tag ref 部署——额外 OAuth 回调地址、部署级运维者白名单如何提供给生产 Worker、`env.production` 重复维护规则，以及回滚方式），`docs/release.md` 描述生产部署，`.env.example` 说明环境作用域（仓库变量共享、secret 按环境设置）。
- **同一 provider 可保存多把 API Key**：应用现在可以在设置页为同一 provider 保存多把 key——每行显示自己的 last4、验证状态与更新时间，并可单独删除（每个 provider 最多 8 把）。重新提交已保存的 key 会就地重新验证该行；只有一把 key 的应用行为与之前完全一致。
- **沙箱用 omp 自带的凭据池在应用的多把 key 之间轮换**：审查容器通过 runner 的 stdin 管道接收该应用的 key 并交给审查 agent 自身的凭据存储，被拒绝或被限流的一把会退避并切到下一把（含逐凭据退避与会话亲和），而不是整次运行钉死在单把 key 上。
- **按 key 模型证据的升级说明**：迁移 `0025` 有意不搬运旧的聚合模型缓存（旧数据无法说明是哪个 key 贡献了哪个模型）。升级前验证过 provider 的应用会看到探测面——模型下拉为空——直到该 provider **每一把**当前 key 都重新验证过，且各 key 的报告至少共享一个模型（可选集合是当前 key 池的交集）。该丢失会自愈，且只涉及可重建的派生缓存：凭据、provider 声明、模型链与席位均不受影响。
- **按 App 的审查门禁——Check 报的是门禁结果，不再是“执行完成”。**
  `mstar-inspector review` 这个 Check 只有在已发布审查的 verdict 属于该 App 的
  通过集合**且**其 tally 分数不低于该 App 的分数下限时才结论为 `success`；
  默认值是通过 verdict `ship it` 与下限 60；从此以后接入的 App 以所属工作区的
  默认值为起始下限（平台默认 60），而在此变更之前就已存在的 App 保留自己已存储的下限
  ——门禁列加入时已存在的每个 App 带的是迁移 `0045` 物化的 80，没有任何步骤把它改成 60。已确认的降级发布、未确认或已过期的尝试、
  执行失败、未达标的已发布审查、无法读取的 App 门禁配置，以及没有可读 tally 的
  已发布审查，一律结论为 `failure`；`neutral` 不再产生（只留在历史行里）。审查按
  该次尝试自己的 publication id 读取，因此同一 commit 上另一次尝试的行无法决定它，
  载荷缺失即判定门禁不通过，而不是回退到那一行。当门禁成为决定因素时，
  summary 会写明 verdict、分数、下限与允许的 verdict；该 run 仍不带 `details_url`，
  仍不是审批、也不是合并门禁。
- **门禁是设置页上的 App 配置。** 设置页的「审查门禁」区块保存分数下限
  （0–100 的整数）与通过 verdict 集合（引擎词汇：`ship it`、`needs fixes`、
  `blocked`、`incomplete`）。越界的分数或词汇表之外的 verdict 会得到带键的 400，
  零写入。空的 verdict 集合合法且按失败关闭——任何审查都不可能通过，页面会在保存前
  给出警告。改动在下一次 Check 生效，无需部署。迁移 `0045` 是追加式的：已有行会
  自动获得默认值，无需回填或访问设置页。
- **新 App 的分数下限是工作区设置。** 工作区设置页新增「审查门禁默认值」卡片
  （`workspaces.check_min_score`，迁移 `0049_workspace_check_min_score.sql`）；接入 App 时用该值作为其分数下限，
  平台默认值为 60。已有 App 保留各自已存储的下限——工作区值只是默认值，不做回填——
  逐 App 的「审查门禁」区块仍是它们的写入入口。
- **Installed Tab 上的所有者允许列表——默认关闭。** 开关关闭时不作任何过滤：
  每个所有者都照旧被审查。开启后，App 只审查 `repository.owner.login` 在列表中的
  投递，`pull_request` 触发与 `issue_comment` 提及同样适用；登录名比较不区分大小写，
  大小写变体会折叠到首次提交的写法。列表在每次保存时整体替换，最多接受 100 个所有者，
  每个条目必须是合法 GitHub 登录名——否则返回带键的 400 并指明该条目，零写入。
  开启且列表为空是合法状态，会拒绝所有所有者（失败关闭），页面会在保存前警告。
- **被拒绝的投递不留任何痕迹。** 不在列表中的所有者得到 `200` 响应——这是策略结果，
  不是可重试的错误——且不写 `webhook_deliveries` 行、不写 PR ledger 行、不触碰
  `last_webhook_at`、不入队任何任务；唯一记录是一条结构化 warn，事件名为
  `owner_not_allowlisted`。拒绝不会进入投递账本，因此这条日志是“被拒绝”而非“丢失”
  的唯一证据。
- **允许列表的读取按失败关闭。** 无法读取的允许列表——读取抛错，或 App 查找之后行
  消失——会以 `500` 拒绝该投递并同样零写入，让 GitHub 重试，而不是让投递绕过一个
  未生效的门禁（`owner_allowlist_read_failed` /
  `owner_allowlist_row_vanished`）。该读取对每一条带仓库所有者的已分类投递都会执行，
  开关开着或关着都一样，因此一次故障现在会表现为投递延迟，而过去这里根本没有任何读取。
  载荷中没有可读所有者（安装事件、畸形 body）无法判定，直接放行。
- **GitHub App 可见性只做探测与缓存，从不用于强制。** App 是公开还是私有并没有可用的
  认证 API 字段，因此 dashboard 以匿名请求探测——不带凭据的 `GET /apps/{slug}`，
  3 秒预算、零重试：`200` 记为 `public`，`404` 记为 `private`，其他答案一律保留
  已存值——无论探测来自元数据刷新路径，还是由开启允许列表强制触发。缓存的
  `github_visibility` 只在允许列表控件下追加一条说明；`404` 对不存在或已改名的 slug
  也同样返回，因此 `private` 只是 UI 提示，绝不参与准入。该控件对每一种缓存值都会渲染
  ——包括私有 App——因为隐藏它会留下一个无法管理的生效过滤器。从未探测过的 App 读取为
  `unknown`，含义是“无法证明是私有”。
- **发布版本号移到平台控制台。** 租户 dashboard 不再渲染版本页脚；平台控制台的
  Runtime 页面显示 `Version vX.Y.Z`，来源与 `/healthz` 和发布 tag 相同的构建期常量，
  在该页面的每种读取状态下都会呈现。
- **按 App 审查触发模式**：每个 App 现在可选择 PR 审查的自动触发时机——`open`（仅首次打开事件）、`every_push`（默认，行为与现状一致）或 `manual`（从不自动触发）——通过应用设置中的分段控件与新增的固定设置操作路由配置；既有 App 行为保持不变。
- **@bot 提及评论触发（破坏性变更——`/review` 已退役）**：在 PR 中评论该 App 的 `@<slug>` 提及即可发起审查；`/review` 命令不再有任何作用，不提供别名，也没有弃用期。提及只对 PR 作者或仓库所有者生效，且必须评在 PR 线程上、发送方不能是 bot 账号，由 `[bot]` 登录名创建的 PR 也永不触发；其他评论不会启动审查。确切的提及字符串会在设置控件旁渲染为可复制的代码片段。
- **工作区设置页。** 侧栏新增 **设置** 入口（`/dashboard/<ref>/settings`），承载工作区 URL（slug）改名，并从应用设置页迁出，避免两个编辑入口。改名仍然只允许所有者：非所有者看到的是拒绝说明，而不是提交后才 403 的表单。侧栏同时改为撑满视口高度。

### Changed

- **安装信息独立成 Tab**：安装表与最近投递从设置 Tab 移入仅管理者可见的「已安装」Tab。投递列表改为最多 10 条（原 5 条），每条标注来源仓库——取自新增的可为空列 `webhook_deliveries.repository_full_name` 的 `owner/name`，迁移 `0043_webhook_delivery_repository.sql` 之前写入的行显示「未知仓库」。
- **PR 详情跳转 GitHub**：头部的 PR 编号与侧栏的仓库名现为 `github.com` 链接，新标签页打开并带 `rel="noopener noreferrer"`。
- **PR 详情记录分页加载**：发现、审查、失败三类记录不再随头部一次性返回，而是按分区按需加载一页（默认 10 行，服务端上限 50）；详情载荷返回 `{ pull_request, counts, latest_review }`、各分区返回 `{ items, total }`，类别 Tab 的计数取自头部计数，上一页/下一页翻页。发现新增严重程度筛选，分页按其筛选后的总数计算。计数中新增该 PR 自身的必须修复项统计：发现类别页签的危险点与发现指标旁的「N 项必须修复」备注都描述这个 PR，因此切换严重程度筛选或翻到后续页都不会让危险点消失、也不会改变备注；没有任何记录的 PR 落在审查页签（记录优先，历史最后）。
- **应用详情页打磨**：返回应用列表的入口移入页面外壳、置于身份头部之上（两个 Tab 共用）；Tab 栏改为 line-tab 面貌——触发器通栏置于 40px 页签栏、底部压发丝线，激活下划线落在发丝线上；管理者的 `?tab=insights` 深链接首帧即落在洞察 Tab（不再闪现设置页），洞察初始加载显示礼貌的加载提示行而非裸筛选工具栏；设置的 identity 分组 eyebrow 更名为「App info」（应用信息）。
- **运行时与工具链 pin 刷新**（Dependabot 驱动）：`wrangler` 4.125.0 → 4.147.0、`vite` 8.2.2 → 8.3.2、`@cloudflare/workers-types` 5.20260825.1 → 5.20261005.1、`@types/bun` 1.4.0 → 1.4.2、`@vitejs/plugin-react` 6.1.1 → 6.1.2、`lucide-react` 1.40.0 → 1.52.0、`tailwind-merge` 3.6.0 → 3.7.0，另含 `react` / `react-dom` 19.2.7 → 19.3.0（配套 `@types/react` 19.3.0）与 `zod` 4.4.3 → 4.6.5。所有 pin 保持精确版本（无 `^`）。
- **TypeScript 5.9.3 → 7.0.2** 及其必需的配置迁移：`tsconfig.json` 与 `tsconfig.spa.json` 均删除已移除的 `baseUrl`，并将 `paths` 目标改写为相对自身文件的形式（`"@/*": ["./src/spa/*"]`）——TypeScript 7 对裸目标报 `TS5090`。
- **Dependabot 第二批刷新**（2026-10-16）：`hono` 4.13.4 → 4.13.13、`@octokit/auth-app` 8.3.0 → 8.3.1、`@cloudflare/workers-types` 5.20261005.1 → 5.20261016.1、`wrangler` 4.147.0 → 4.151.0、`vite` 8.3.2 → 8.3.4、`@types/bun` 1.4.2 → 1.4.3、`@types/react-dom` 19.2.5 → 19.3.0、`lucide-react` 1.52.0 → 1.57.0，外带 9 个 `@radix-ui/*` 组件包（`react-dialog` 1.1.23 → 1.3.1、`react-dropdown-menu` 2.1.24 → 2.2.1、`react-select` 2.3.7 → 2.4.1、`react-separator` 1.1.15 → 1.2.0、`react-slot` 1.3.3 → 1.5.0、`react-tabs` 1.1.21 → 1.2.1、`react-toggle` 1.1.18 → 1.2.1、`react-toggle-group` 1.1.19 → 1.2.1、`react-tooltip` 1.2.16 → 1.4.1）。所有 pin 保持精确版本（无 `^`）。
- **破坏性变更——一个部署形态变量，一条租户读取路径。** v1.2 的租户模式已被彻底删除：
  没有读取方、没有校验器、没有 workflow dispatch 输入、没有 `--var`、没有
  `env.production.vars` 条目、没有 replay 守卫。租户读取不再有条件——所有面向执行的
  App 读取都 INNER JOIN `app_workspaces`，且 `/dashboard/<workspace-slug>/apps…`
  是唯一的 App 路由族，因此工作区之前的前缀路径（`/dashboard/apps…`、
  `/dashboard/api/apps…`）返回 404。**升级提示：** 请删除已无用的
  `WORKSPACE_TENANT_MODE` GitHub Actions 变量以及任何 `tenant_mode=…` 的 dispatch
  习惯；两者都无人读取，不要保留残留值。
- **新增 `DEPLOYMENT_MODE` Worker 变量（`self-hosted` | `saas`）**——它替代的是
  *产品形态*这条轴，而不是读取路径。它只决定一个问题：`users` 表为空的实例，是否向
  其第一个登录者讲述「空实例」故事（本次登录已成为该实例上的账号，下一步是创建工作区）。
  `saas` 永不显示该页面。两个部署 workflow 都用 `--var` 传 `saas`，
  `env.production.vars` 声明 `saas`，本地开发声明 `self-hosted`。**没有默认值**：
  未设置、空值或任何其他值都会在启动时明确失败
  （`DEPLOYMENT_MODE must be "self-hosted" or "saas", received <value>`），SPA 启动
  面与 OAuth 回调面会以该文本返回 500，而不是按猜测的形态提供服务。webhook 与队列
  消费面从不读取它，因此错误值既不会让 webhook 404，也不会中断 review。
- **一次部署，而非两阶段上线。** 同一个构建不再需要在同一 SHA/tag 上先 `off` 再
  `strict` 重放，因此 `tenant_mode` 与 `expected_deploy_sha` dispatch 输入、replay
  绑定以及 `scripts/resolve-tenant-mode.sh` 均已删除。保留下来的是保护普通部署的部分：
  在每个可部署步骤之前断言运行 ref 身份（staging 校验 checkout 的 `HEAD`，production
  校验 `refs/tags/<tag>^{commit}`，因此被移动的 tag/分支永远无法部署）、迁移与幂等的
  `0027` App 归属修复先于第一个创建版本的步骤、零孤儿门禁在任何部署之前中止并在对外服务
  版本上再次断言。回滚方式是对 merge commit 执行 `git revert`——配置层的模式开关已不存在。
- **新增工作区归属数据面**（迁移 `0026`/`0027`/`0030`）：每个 App 与 dashboard 用户
  都归属某个工作区。`0027` 把既有 App 归属到 `default` 工作区，且是唯一可重放的一半
  （两个 deploy workflow 都会在任何可部署步骤前重跑它）；`0030` 按切点范围、只执行一次地
  回填开放登录之前用户的成员关系——若把「按人写入」的那一半做成可重放，每次常规部署都会把
  所有登录（包括已被移除的成员）重新加回 `default`。两个 workflow 都会在存在未映射 App
  时于任何可部署步骤之前中止。
- **深色主题成为确定性默认**：SPA 不再跟随操作系统的 `prefers-color-scheme` 浅色回退——有效主题取导航栏切换的已存选择，未设置时即为深色；文档 body 现在会绘制主题画布，应用四周不再出现无样式留白。已存的切换选择仍然优先。
- **Dashboard 的 App 链接改用 GitHub App id（破坏性变更）**：App 详情页与所有 App 级 API 路径都以数字 `github_app_id` 为键（`/dashboard/apps/{githubAppId}`、`/dashboard/{workspaceRef}/apps/{githubAppId}`）。用本地 slug 拼出的旧链接与书签不再匹配，且不提供重定向。该本地 slug 已不复存在——列已重命名为 `webhook_path`，仅作为不透明的 webhook 路由键，因此现有 webhook URL 保持不变。
- **App 显示自己的 logo，而不是所有者的头像**：设置页身份卡与 Apps 列表改为渲染 App 机器人账号的头像（`GET /users/{slug}[bot]`）——REST `GET /app` 没有 logo 字段，此前的图片是 App 所有者的头像。
- **管理者可按需刷新 App 的 GitHub 元数据**：设置页的「从 GitHub 刷新」会重新拉取缓存的名字、描述、设置页 URL、slug 与 logo，并绕过 24 小时懒刷新，因此重命名或更换 logo 会立即生效。上游失败时显示带键错误并保留缓存值。
- **Bot 提及使用 GitHub 的真实 App slug**：设置页展示由 `github_slug`（注册时与每次元数据刷新时写入）拼出的 `@<slug>` 提及；首次同步前不显示任何提及，而不是本地臆造的名字。提及语法与授权规则保持不变。
- **App 名称按 GitHub 事实逐级回退**：Apps 列表与设置卡依次渲染 `github_name`、`github_slug`、数字 App id，并在旁显示缓存的 App logo。
- **升级步骤：部署后为每个已有 App 同步一次元数据**：`github_slug` 没有回填，因此部署后所有已存在的 App 在元数据拉取一次之前都不响应 bot 提及——打开它的设置页**或**点击「从 GitHub 刷新」——两者都会同步，因为 `github_slug` 仍为 NULL 的行不计入 24 小时元数据缓存有效期内，会被视为未同步。处于 `manual` 触发模式的 App 只靠提及触发，在此之前不会进行审查。当 App 的 slug 仍未知而有评论提及了某个登录名时，webhook 面会记录结构化 `mention_unresolved` 警告（带 `webhook_path` 与 App id），因此未同步的 App 可见，而不是静默忽略投递。
- **harness 升至 4.4.0（根、runner 与审查镜像）**：根 manifest 的 `@mstar-harness/engine` 区间改为 `^4.4.0`，`packages/runner` 的精确 pin 改为 `4.4.0`，镜像全局安装的 `@mstar-harness/cli`、`HARNESS_VERSION` / `harnessRef` pin（ref `a6721f5231e74ade74e80af5b1596edc6898f4be`，tag `v4.4.0`）与 Dockerfile 克隆 ref 一并向 4.4.0 移动；所有 lock 重新生成，并在同一提交中更新镜像重建标记——这些 manifest 与所 pin 的 ref 都是镜像输入。
- **审查正文不再携带 unverified 计数**：引擎移除了该统计分桶，因此席位线契约、席位合并、父级输出契约与 inspector 的信封 schema 一并去掉该字段，已发布的审查正文只渲染 must-fix / should-fix / may-fix / nit 四行。已存储的信封保留写入时的全部字段——读取路径不会按新形状重新校验。
- **harness 升至 4.4.1（根、runner 与审查镜像）**：根 manifest 的 `@mstar-harness/engine` 区间改为 `^4.4.1`，`packages/runner` 的精确 pin 改为 `4.4.1`，镜像全局安装的 `@mstar-harness/cli`、`HARNESS_VERSION` / `harnessRef` pin（ref `e834dce3ff66403463207e267fd4bcf62c8d4d55`，tag `v4.4.1`）与 Dockerfile 克隆 ref 一并向 4.4.1 移动；所有 lock 重新生成，并在同一提交中更新镜像重建标记——这些 manifest 与所 pin 的 ref 都是镜像输入。本仓库没有需要适配的 API 变化：4.4.1 只在 harness 自身的表面上新增 specs/ADR 文档层 lint 与 skill 语料的勘误。
- **harness 升至 4.5.2（根、runner 与审查镜像）**：根 manifest 的 `@mstar-harness/engine` 区间改为 `^4.5.2`，`packages/runner` 的精确 pin 改为 `4.5.2`，镜像全局安装的 `@mstar-harness/cli`、`HARNESS_VERSION` / `harnessRef` pin（ref `1a6a90c3fe097e618ec6ebd154b630857ad1f3be`，tag `v4.5.2`）与 Dockerfile 克隆 ref 一并向 4.5.2 移动；所有 lock 重新生成，并在同一提交中更新镜像重建标记——这些 manifest 与所 pin 的 ref 都是镜像输入。4.5.0 将完成载荷中的 `qa` 载体更名为 `acceptance`，并在 harness 自身表面上为 issue 增加 `obsolete` 终结态；4.5.1 将受控语料的默认路径改到 `.agents/<kind>/`（`.mstarc` 仍是权威配置）。本仓库已声明的语料布局，以及所消费的 review/seat 契约，不因这次 pin 升级而改变。
- **采用 engine 4.0.2**：`@mstar-harness/engine` 4.0.1 → 4.0.2，新增 PR 审查的第四种中性结论 `incomplete`；两处审查输出 schema 均已声明 `incomplete` 事实，深度父会话 yield schema 还接受 engine 输出的 tally `band`，合法深度审查 yield 不再因此被拒。
- **`incomplete` 结论及其必需事实**：PR 审查现在可报告 `incomplete` 并附带 `{ reason, unscanned }`——声明的原因与本次未覆盖的范围（范围列表可为空）。该事实仅由 `incomplete` 结论携带、在其他结论下被拒绝，若提供 tally 则必须原样回显；深度父会话 yield schema 与 envelope 解析器都会保留它，不再丢弃。发布的审查正文会在结论（及存在时的 tally）下方渲染 `cause:` / `unscanned:`，其他结论的正文与之前逐字节一致。
- **沙箱镜像的 harness 输入升至 4.0.2**：omp 镜像的插件 clone ref 与预装的 `@mstar-harness/cli` pin 均跟随标签 `v4.0.2`。
- **Harness 语料迁入 mstar 4.4.1 布局**：受跟踪的工程语料拆成三层——`.agents/knowledge/`（工程经验与可复用范式，自 `.mstar/knowledge/` 原样迁移并保留历史）、`.agents/adr/`（一条记录一个决策，含真实备选与代价，按 `{bucket}/{class}/` 归档）、`docs/specs/`（当前状态契约，固定 `Scope` / `Current state` / `Invariants` / `Where it lives` / `Change obligations` 骨架）。旧 `.mstar/specs/` 树已删除；其规范内容在新 spec 中存续，已退役写入的 M1 review-output 契约保留为 archived ADR。
- **`.mstarc` 改为 git tracked**，声明目录布局（`knowledge_dir`、`adr_dir`、`specs_dir`），克隆后无需逐宿主配置即可解析到同一批目录。
- **spec 按代码校正**：`webhook_path` 已删除（迁移 `0038`；webhook 路由为 `/webhook/:workspaceId/:appId`）、平台级 `review_global` 总闸与 per-App 开关并存、flag 读取为点读且 worker 侧异常 fail-closed、邀请席位守卫绑定具名 `:limit`、拒绝文案携带实际限额、`@octokit/auth-app` pin 为 8.3.1。
- **harness engine 升至 4.2.0（根与 runner）**：根 manifest 的 `@mstar-harness/engine` 区间改为 `^4.2.0`，`packages/runner` 的精确 pin 改为 `4.2.0`；两份 lock 仅重新解析 engine 依赖图，无传递依赖变动。
- **审查沙箱镜像跟进到 4.2.0**：镜像全局安装的 `@mstar-harness/cli`、`HARNESS_VERSION` / `harnessRef` pin 与 Dockerfile 克隆 ref 一并移动，并在同一提交中更新镜像重建标记——runner manifest、CLI manifest 与所 pin 的 ref 都是镜像输入。
- **本条目不涉及运维动作**：变更内容为版本 pin、lock、pin 契约与重建标记——未执行镜像构建、部署或 smoke。
- **harness engine 升至 4.2.2（根与 runner）**：根 manifest 的 `@mstar-harness/engine` 区间改为 `^4.2.2`，`packages/runner` 的精确 pin 改为 `4.2.2`；两份 lock 重新生成，`@oh-my-pi/pi-coding-agent` 仍为 18.13.3。
- **审查沙箱镜像跟进到 4.2.2**：镜像全局安装的 `@mstar-harness/cli`、`HARNESS_VERSION` / `harnessRef` pin（ref `98504a71dcf09cfb551847b85e81d33e682e0bd9`，tag `v4.2.2`）与 Dockerfile 克隆 ref 一并移动，并在同一提交中更新镜像重建标记——runner manifest、CLI manifest 与所 pin 的 ref 都是镜像输入。
- **本条目不涉及运维动作**：变更内容为版本 pin、lock、pin 契约与重建标记——未执行镜像构建、部署或 smoke。
- **文档整理**：审查 runner 的 recheck 注释改为指向沙箱镜像实际复制的共享源码树（`packages/shared/src`），而不是已退役的 contracts 路径；生产环境回滚手册记录了 D1 恢复的限制，以及运维在风险部署前必须保存的 bookmark。
- 从 App 详情 → 洞察移除「按类别统计的发现」图表与「重复出现的发现」表格。类别轴是模型输出的开放集 slug，其桶并集不构成可比较的指标。
- `/api/apps/:appId/insights/summary` 不再返回 `findings_by_category`、`recurring_top`，`findings_distribution` 行内也不再含 `by_category`；其余字段不变。读取这些键的外部调用方按设计失效。
- **平台运维台支持中英双语。** 运维台（`/_internal_admin/*`）的页头、导航、页面文案以及
  空态 / 加载 / 错误态都按运维者所用语言呈现，与工作区外壳共用同一个 `boot.locale`。语言
  切换沿用了仪表盘的无 JS 表单：向 `/dashboard/locale` POST 一次后以新 Cookie 重新加载
  文档，偏好 Cookie 现在同时覆盖仪表盘与运维台路径。
- **开关旗标前先确认。** 点击服务器旗标的开关会先弹出对话框，写明旗标名称、
  开 → 关（或反向）的变更及其影响，然后才允许写入；只有确认按钮会发出唯一的
  `PATCH /api/flags`，随后显示一条短暂的“已保存”提示。
- **运维台表格支持搜索。** 用户与工作区表格新增客户端搜索输入框和“已显示 / 总数”计数——
  过滤在已加载的行内进行，不产生 URL 状态，也不发起额外请求。
- **支持授权表单放进真正的卡片里。** 授权创建表单移入 `SectionCard` 的
  `CardHeader` + `CardContent` 之内，与支持 / 设置页结构一致，不再使用临时的散装包裹。
- **部署运维者不再自动获得租户权限。** 已没有任何部署级白名单会授予租户权限；
  新的 `PLATFORM_OPERATORS` 变量只是运维控制台与 support 授权视图的白名单，默认不授予任何权限。
  拥有有效授权的运维者能读取工作区身份字段、成员名单，以及 `GET
  /dashboard/<ref>/api/support/grants`——在该路径上运维者只能看到自己的授予行，而租户通知包含全部有效授权。工作区网关按
  `member → invitee → operator-granted → operator-denied → outsider` 分类：本身是成员的
  运维者仍享有普通成员权限；没有有效 `support_grants` 行的运维者得到与外部人完全相同的
  404；**拥有**有效授权的运维者只能读取上述三项。App
  列表、App 设置、凭据、模型链、设置写入、角色变更、移除成员、邀请与审计列表对已授权
  运维者一律返回 403。
- **每一次授权判定都在网关内留痕。** 当请求被分类为 operator-granted 或 operator-denied 时，
  工作区中间件在派发之前恰好追加一条 `audit_events` 记录——`support.read`、
  `support.forbidden` 或 `support.denied`——因此路由处理器无法跳过该记录。本身是普通成员的
  运维者走 member 分支，不写审计行。HTML 外壳加载（`/dashboard`、`/dashboard/<ref>/apps`）由
  `spa-dispatch` 派发、不经过工作区网关，故不写审计行。授权是限时的，每次请求按
  `expires_at` 判定；过期授权与无授权表现完全一致。
- **租户看得见这段窗口。** 工作区的所有成员都会看到一条不可关闭的通知，写明运维者、
  授权原因与到期时间——且不提供任何结束或编辑授权的控件。`owner`/`admin` 可以通过
  `GET /dashboard/<ref>/api/audit` 读取审计记录，普通 `member` 返回 403。通知在每个工作区
  会话中只读取一次——外壳在客户端导航间存活——因此中途过期（或新增）的授权要等到刷新
  页面才会变化。
- **拉取请求详情：记录胶囊行现在承载筛选器，右侧栏与它顶端对齐。** 发现严重程度筛选从发现列表内部移到三类别胶囊旁的工具栏位；内容区改为两列外壳，右侧「拉取请求／活动」栏与同一行顶端对齐，而不是落在记录列表下方——右侧栏再高也不会把左侧列表往下推。
- **审查行改为两行事实**：第一行是轮次、短提交（链接到 GitHub commit）、模型署名与本轮耗时；第二行是结论加上按类别拆分的发现数（`必须修复 2 · 建议修复 1`）。不属于当前合并类别词表的类别——即旧记录里的 `critical/warning/suggestion/info`——不再被丢弃，而是汇总为末尾一个 **其他** 计数；每行右侧窄列居中显示审查时间。
- **发现卡片**：「第 N 轮」标签移至卡片右下角，改为小号内嵌药丸，不再挤占标题行，且与审查行的轮次标签同形同号。
- **拉取请求详情面围绕固定高度的首屏重建**：PR 事实与聚合指标进头部带状区；发现 / 审查 / 失败改为分段胶囊切换的记录类别并各自带计数；发现按严重度分组（must-fix 展开、其余分组收起）；最新审查展开、历史审查收起；失败块显示首行错误、完整输出收在折叠区内；侧栏（`xl` 以下满宽、`xl` 及以上 256px 宽）承载 PR 自身事实与合并后的活动时间线。已批准原型归档为 design-system 参考页（`src/design-system/prototypes/record-detail.html`，与 `DESIGN.md` 配合阅读的 proposal 参考，不是已发布组件）。
- **提供方目录刷新到最新快照**：审查 runner 升级到 omp `18.18.1` 与 mstar-harness `4.2.3`（engine + CLI + 镜像 pin），生成的提供方目录改用 `2026-11-06` 的 models.dev 快照与 omp `18.18.1` 自带的模型注册表重建。omp 快照现在由 `scripts/provider-catalog/extract-omp-snapshot.ts` 生成（`bun run provider:catalog`），升级依赖后一条命令即可刷新目录。
- **提供方的模型列表完整呈现**：移除抽取阶段与内置提供方的代表模型上限；混合协议的提供方（如 Command Code、OpenCode Go）按协议拆成独立条目并携带完整模型表，设置页卡片的模型展开显示目录全量，而不是截断样本；单个声明可保存的模型 id 上限从 32 提高到 128，完整词表可以一次选中。
- **Provider 密钥验证不再产生推理调用**：dashboard 的每次密钥检查都是对 provider 的 models/usage/identity 端点发起 `GET`，剩余的 1-token chat 探测已移除；验证失败不写入任何内容。`kilo`、`umans` 仍然可验证（走其公开模型列表），但只记录较弱的 `reachable` 状态（公开列表对任意 bearer 都返回 2xx）；`zai` 是唯一 `unsupported` 的 provider（没有文档化的 models/usage 端点）。
- **`ok` 现在意味着探测能够拒绝该密钥**：由同一份「会拒绝错误密钥的探测 URL」白名单决定内置与自定义保存的 `ok` / `reachable`，因此验证通过的密钥不会再被存成未验证状态。OpenRouter 仍使用公开的 `GET /api/v1/models`——模型选择器的候选正来自该目录——而它对任意 bearer 都返回 2xx，因此其保存记录 `reachable` 而非 `ok`（omp 更严格的 `/api/v1/auth/key` 返回的是账号数据而非模型列表，把规格移过去会让 OpenRouter 没有任何可选模型）。
- **内置验证表与 omp 18.13.3 对齐**：新增 vendored 快照 `scripts/provider-catalog/omp-provider-verify.json`，记录全部 `validate "models-endpoint"` 条目（28 个端点，源版本与提取日期写在其头部），内置规格通过既有的 provider id 别名映射从该数据派生。
- **自定义 provider 探测 URL 归一化并显式声明身份**：声明的 base URL 用 `new URL()` 解析（以 `/`、`/v1`、`/v1/` 或 `/models` 结尾都得到唯一的 `…/models` 探测地址；携带的 query/fragment 被丢弃），无法解析的 URL 现在报告 `unreachable`，而不是把异常当作验证失败上报；所有验证请求都会发送 `Accept: application/json` 与显式 `User-Agent`。以上改变的是探测请求的构造与发送方式；偶发的「无法连接」误报其根因未在已部署的 Worker 上得到确认，因此不声称该症状已消除。
- **自定义 provider 获得其他入口已有的多密钥池**：新增需要身份验证的设置操作，向已存在的自定义声明追加密钥（先按已存储端点验证、不改写声明，端点锁与 8 把密钥上限保持有效），自定义 provider 行上新增「添加密钥」操作，并渲染与其他入口一致的掩码逐密钥行。
- **拉取请求详情：**每条审查行现在显示轮次（`第 N 轮`）、该轮报告的发现数与运行耗时；审查页不再依赖空白的摘要折叠区（该折叠已移除）。发现行会标出首次报告它的轮次。
- **存储：**新增可空的 `reviews.duration_ms` 列；此前写入的行保持 NULL，界面不显示其耗时。
- **README refocused on self-deployment (English + 中文).** The Quick start is
  now the single self-host path; the repo's own staging path and the
  production / release-train detail moved out of both READMEs — both were
  already covered in `docs/deploy.md` / `docs/release.md`. The Architecture
  section reflects the Multi-App shape (dashboard registration, per-slug
  webhook routing, per-App encrypted credentials in D1) and the
  `DEPLOYMENT_MODE` deployment-shape switch (details linked, not inlined).
  The Chinese README additionally gains the review-behavior sections that had
  drifted out (credentials scoping, permissions, advisory Check runs, recovery
  semantics). Stale facts fixed in both: Bun `>= 1.4.0` (matches
  `package.json` engines) and review runner levels `quick|default|deep`
  (`deep` is alive per `packages/runner/src/runner.ts`).
- **审查评论正文改由 engine 渲染**：`@mstar-harness/engine` 的 `renderReviewMarkdown` 负责版式——结论行（含分数）、`cause:`/`unscanned:` 事实对、计数表、`## 📋 Review`，以及按席位排序的每条 finding 区块——因此结论、分数、计数与 finding 标题不再出现两次。本仓库只保留 engine 无法表达的部分：省略条目的脚注，以及折叠的往轮复审。
- **席位叙述改为可选**：runner 输出契约不再要求 `summary_md`，engine 4.1.6 也不再伪造它；没有席位自述摘要时，正文只渲染空的 Review 标题，而不会把机器事实回灌进摘要。
- **轮次标题移到底部**：`Review N · commit <sha>` 现在是紧贴发布标记上方的尾行；隐藏的轮次标记仍保持第一行。
- **审查沙箱版本组合升至 mstar-harness 4.1.6**：engine manifest 区间、runner 精确 pin、预装 CLI pin、镜像 tag/ref 与重新生成的 lock 一并移动——任何一处漂移都会让 pin 测试套件失败。
- **跨轮重复项提示已移除**：engine 的计数表不再由本仓库重算，因此重复项既无法在原位标注，也无法从计数中排除。它列出的标题 finding 区段本来就有，往轮复审表才是回答「之前的关注点怎么样了」的地方；其存储查询与测试一并删除。
- **审查镜像会重建**：runner 不再要求席位摘要，这半改动必须与上方的 engine pin 一同发布。
- **审查并发上限调整**：平台配额默认值及可设置上限为 **256**，每个工作区受自身上限 **32** 约束，因此默认准入由**每个工作区 16 提升至 32**（Cloudflare Queues 同时最多投递 250 个，该总量只能由至少 8 个工作区各自跑满 32 聚合达到）。工作区设置不再显示或返回平台上限，写入只按自身范围（1..32）校验——平台配额在准入时生效，因此任何租户请求都不会因被拒绝而暴露它。升级时，此前在 1..64 范围内存储了大于 **32** 的工作区会被迁移 `0043_workspace_concurrency_bound.sql` 下调为 **32**，每个旧值都记录在 `workspace_concurrency_clamp_0043` 中。
- **停止的审查席位不再导致整轮失败**：quick/default 审查只要有席位被墙钟上限停止，就会发布 `incomplete` 结论，声明原因与未完整覆盖的范围——每个被停止的席位一条，各自标明该席位被分配的范围——而不再丢弃整轮审查；已返回席位收集到的发现会被保留，因此该轮被如实报告为「未定论」而不是丢失。
- **发布正文中的原因/范围对只出现一次且有界**：渲染器输出的 cause 与 unscanned 行按行截断并加省略号，摘要中由模型写入的重复行仅在渲染时剔除（存储的 envelope 仍保留已验证的取值）；没有席位被停止的轮次与之前逐字节一致。
- **未产出 yield 的 deep 审查同样以 `incomplete` 发布**：当 deep 父回合结束时没有产出结构化 yield，该轮不再失败——而是发布 `incomplete` 结论，携带该回合已收集的摘要、它声明的原因以及未完成的 deep 范围（整个 diff，一条）；没有终态结束的 prompt 报错、以及被契约拒绝的 yield 仍然致命。渲染的范围行在拼装之前先做上界判定——放得下的列表原样输出，只有溢出的列表才停在预算处并以省略条数标记结尾——而存储的 fact 仍保留已验证的取值。
- **原先叫「运行时镜像」的 App 设置现在称为运行时 harness。** 沙盒镜像只有一个构建；选择器真正选的是挂载进去的 harness（`omp`）。卡片、保存提示、provider 可用性文案与保存拒绝提示在中英两种语言里都改称 harness。存储标识（`sandbox_image_id`、注册表与保存操作）保持不变。
- **沙箱 harness 镜像 pin 升级到 mstar-harness 3.10.2**（自上一版本发布时的 3.8.1 起累计）：沙箱镜像的插件 clone ref、`@mstar-harness/cli` 预装 pin、仓库 manifest 区间与锁文件、部署文档 pin 表同步更新，pin 链测试同步重指。
- **沙箱镜像 pin 升级**：mstar-harness 3.10.2 → 3.11.2（插件 clone ref、CLI 预装、manifest 区间、部署文档 pin 表），omp SDK（`@oh-my-pi/pi-coding-agent`）18.0.4 → 18.2.6。
- **沙箱镜像 pin 升级**：mstar-harness 3.11.2 → 4.0.0（插件 clone ref、CLI 预装、manifest 区间、`engines.bun` 下限、部署文档 bump 叙述）。
- **审查沙箱的版本组合升至 omp 18.12.3 / mstar-harness 4.0.4**：镜像 pin 块（harness tag/ref 与预装的 `@mstar-harness/cli`）、`@mstar-harness/engine` `^4.0.4` 的 manifest 区间、`@oh-my-pi/pi-coding-agent` pin 与重新生成的 lock 一并移动——engine 区间、其 lock 解析、镜像 CLI pin 或派生的 skill 版本一旦不一致，pin 测试套件即失败。
- **审查 envelope 现在可通过 harness 的 persist 面离开 Worker**：`scripts/mstar-export-review.ts` 用 engine 校验单个 `mstar.review/v1` envelope，并以 `review` artifact 写入——默认使用解析出的 harness 根目录下的 `FsStore`，可用 `--store <module>` 注入自定义 store 模块。这不是 D1 审查存储的迁移：发布 journal、租约、复现查询与 dashboard 读取仍留在 D1。
- **本条目不涉及运维动作**：变更内容为 pin、一个 CLI 侧脚本及其测试、以及文档——未执行镜像构建、镜像内回放、部署或 smoke。
- **审查沙箱的版本组合升至 omp 18.13.3 / mstar-harness 4.1.2**：镜像 pin 块（harness tag/ref 与预装的 `@mstar-harness/cli`）、`@mstar-harness/engine` `^4.1.2` 的 manifest 区间、`@oh-my-pi/pi-coding-agent` pin 与三个重新生成的 lock 一并移动——engine 区间、其 lock 解析、镜像 CLI pin 或派生的 skill 版本一旦不一致，pin 测试套件即失败。
- **提供方选择器现在覆盖 omp 支持的每一个 API-key LLM 提供方**：把 omp 目录的固化快照并入生成的提供方目录，作为 `template` 行，因此 models.dev 快照缺失的提供方（Command Code、TypeSafe、Qianfan、SambaNova、LiteLLM、Ollama、vLLM、AIML API、CoreWeave、Fire Pass、Helmcode、Yolo-Auto、Qwen Portal 以及两个 SingularityAPI 网关）无需手写自定义提供方即可选择。新增行全部为 `template` 层，19 个内置 BYOK 提供方、其 env-name 白名单与 models.yml 合成逻辑均未改变。
- **`typesafe` 加入自定义提供方协议集合**：声明现在可指定 omp 的 TypeSafe 协议，并通过 OpenAI 形态的 Bearer models 探测验证。Command Code 按模型混合协议，因此物化为两行——`commandcode`（Responses）与 `commandcode-anthropic`（Messages）。
- **端点可达不再等同于密钥已验证**：声明式自定义/模板提供方只有在 models 端点确认会拒绝伪造密钥时才记录 `verified_status = "ok"`，其余一律记录 `reachable`——因此 Command Code 的公开 `/provider/v1/models` 与所有其他声明（包括运维自填的 `base_url`）都落到 `reachable`，设置行显示「端点可达 … — 密钥未验证」而非「已验证 …」。目前仅 `api.typesafe.ai` 在白名单内（omp 用其 `/v1/models` 校验密钥），内置提供方仍记录 `ok`——它们的探测都会拒绝伪造密钥。
- **本条目不涉及运维动作**：变更内容为 pin、带固化输入的生成目录、协议管线与测试——未执行镜像构建、镜像内回放、部署或 smoke。
- **OMP 升级至 18.18.1**：根项目与 runner 的固定版本从 18.17.0 升至 18.18.1，两个锁文件均已重新生成，沙箱镜像也会重建。重新生成的固化提供方目录仅更新版本与提取日期；提供方列表、模型 ID 和请求头钩子均未改变。
- **镜像的 harness ref 与其 tag 对齐**：`harnessRef` 在 `4.2.3` 版本下仍指向 `v4.2.2` 的提交，导致 `REVIEW_SKILL_VERSION` 读作 `4.2.3+98504a71` —— 该后缀不对应任何 `v4.2.3` 检出。现已改为 `v4.2.3` 的提交 `abf3167d`，并新增契约测试把 Dockerfile 的克隆 ref 锁定到它。此改动之前记录的审查保留其历史后缀。
- **omp SDK 升级**：`@oh-my-pi/*` 依赖线（`@oh-my-pi/pi-coding-agent` 及其依赖图）18.2.6 → 18.11.1；review runner 的凭据写入改用 SDK 命名空间化的 `AuthStorage.credentials.set` / `credentials.list` API，内存凭据库、models.yml 合成与会话形状均不变。
- **Sandbox SDK 0.12.8 → 1.0.0**：1.0 不再提供 `Sandbox` 类与 `getSandbox()`，因此 `src/pipeline/sandbox.ts` 改为在仓库内自写 Durable Object，由其自行启动并驱动容器（`this.ctx.container`），对 Worker 暴露同样的 `runCommand` / `destroy` RPC。
- **容器配置改走 Durable Object 调度策略**：`wrangler.jsonc` / `wrangler.smoke.jsonc` 使用 `scheduling_policy: "durable_object"` 与具名镜像映射（实例规格移入 `container.start()`），容器应用启用一个**新的名称**——不能再复用 0.12 时代的应用名。
- **评审沙箱镜像改为自有基础镜像**：SDK 不再提供运行时基础镜像，Dockerfile 改从按 digest 固定的 Debian 基础镜像起步（linux/amd64）——基础层及其 libc 被冻结、不会静默漂移；apt 安装的工具（`ca-certificates`、`curl`、`git`）在构建时仍取自滚动套件。随后从对应的 1.0.0 镜像复制 `sandbox-shim`；长驻默认命令保证容器存活。
- **消费方契约不变**：`ReviewSandbox`、`getSandbox(binding, id)`、`ShellCommand` 品牌化的单一汇点边界与每命令 600 秒上限语义均保持不变——上限触发时改为返回退出码 124，而不再抛错。
- **PR 只审查最新提交**：如果某次投递的 PR head 之后已经前进，该投递会在创建任何沙箱之前被确认为 `superseded`——不起容器、不重试、不写失败记录——由携带当前提交的那次投递来执行审查。该跳过还要求那个更新的提交确实拥有一个已入队的任务（其幂等键只在入队成功后才写入，守卫彻底丢弃该任务时改写为 `dropped`）。因此，当 head 是由「什么都没入队」的投递（`open` 模式下的 `synchronize`、已暂停的 App、失败的入队）推进时，本次投递绝不会被跳过。该证明只在写确认的那一刻读取一次，并不是预留：如果那个更新的任务之后被彻底丢弃，PR 的 head 仍会没有审查，只有丢弃留下的 `review_failures` 记录，且不会自动重新入队。这次确认还会在被超越提交自己的幂等键上写入 `superseded`（同一 TTL），因此 worker 不会重新入队一个已被更新提交取代的提交——该值绝不构成「更新提交已在排队」的证明——但如果强推回到一个曾被 `superseded` 的提交，它会被重新入队，因为它可能再次成为 head。一条带 `event=review_superseded` 的结构化 info 日志会写明超越它的、更新的 `head_at`，因此缺少审查时不必再查一次就能解释。
- **新提交不再被延迟重试窗口丢弃**：被 `pr-held` 挂起的消息现在按 `60/300/1200` 秒（quick/default）或 `90/480/1200` 秒（deep）重试。累计等待超过该级别的 guard TTL，因此锁在最后一次延迟尝试之前被释放或过期时，重试会被接纳，新提交也就得到审查。若审查的存活时间超过整个计划，消息仍会被丢弃，而这次丢弃会被记录下来——绝不无声。
- **水位只前进不后退**：账本保留该 PR 最近一次带时间戳投递的 `pull_request.updated_at`——同一个提交的投递也会推进它，这是无害的，因为跳过还需要「不同的提交」——而 `head_sha` 绝不回退：乱序到达的投递（无论带不带时间戳）都会保留更新的那个提交。在同一时刻到达、或属于最新提交的投递始终会被审查。`issue_comment` 任务以及任何没有该时间戳的消息——包括本次部署之前的全部流量——完全走原有路径，账本读取失败或行不存在时一律按正常审查处理，绝不跳过。
- **Webhook 体积上限按流式字节生效**：413 请求体积上限不再信任客户端提供的 `content-length` 头——即使该头缺失或造假，请求体也会在流式读取超过上限的瞬间被拒绝。
- **由 bot 创建的 PR 不再审查**：`pull_request` 事件的作者登录名以 `[bot]` 结尾时（`dependabot[bot]`、`github-actions[bot]`、其他 App 自己的 `<slug>[bot]`），直接忽略、不进入队列，与 App 的触发模式和 action 无关。`issue_comment` 面同样适用，因此在这类 PR 上 @提及也不会启动审查。后缀匹配不区分大小写，且只看后缀：不含 `[bot]` 的登录名仍会触发，与账号类型无关。
- **作者缺失时 fail-closed**：delivery 若缺少 PR 作者登录名（`pull_request.user.login` / `issue.user.login`），无法证明由真人创建，两个触发面都会忽略而不审查。GitHub 总是发送该字段，此项只覆盖被截断的 payload。
- **跳过会记录日志**：因作者原因跳过 delivery 时，两个触发面各输出一条 info 级结构化日志（`reason` 为 `bot_author` 或 `missing_author`，并带作者登录名与 PR 编号），运维可直接看出某个 PR 为何没有审查。HTTP 响应与 delivery 行的 `ignored` 词汇保持不变。
- **评论面守卫顺序**：PR 线程判定与 bot 作者判定都先于提及语法执行，因此 bot 创建的 PR 以及普通 issue 上的评论都不会报告「未匹配到提及」。未同步 App 的 `mention_unresolved` 运维告警相应只保留给非 bot 作者 PR 上的评论。状态码也随之变化：action 在白名单内但缺少必需字段（installation id、repository、issue number）的 `issue_comment` 现在会在作者/提及/参与者判断之前返回 400，这类被截断的 delivery 记录为 `rejected` 而非 `ignored`；action 白名单仍然最先判断。
# Breaking: per-App webhook URL is now `<workspace_id>/<app_id>`
The webhook delivery URL for every GitHub App is now
`<origin>/webhook/<workspace_id>/<app_id>` — the workspace's stable id and the
App's local row id, both immutable internal identifiers. The old single-segment
`/webhook/<uuid>` route is **retired with no compatibility path**: GitHub keeps
delivering to the old address and receives a **404** until the App's Webhook URL
is updated.
**Upgrade step (required).** After deploying, open each App's settings card
(`/dashboard/<workspace_id>/apps/<github_app_id>/settings`), copy the
**Webhook URL** it prints (both segments are shown on the card, including the
Local App ID), and paste it into the GitHub App's settings → Webhook → Webhook
URL. Until then the App receives no events.
Migration `0038` rebuilds `github_apps` to drop the now-duplicate
`webhook_path` column (SQLite cannot drop a `UNIQUE` column, so this is a
table rebuild inside the migration transaction — a brief write lock on a small
table; every row survives). No data is migrated: the two URL segments already
exist in the database.
- **登录开放；工作区是创建出来的，不是被分配的。** 部署级的登录名名单已删除：任何完成
  OAuth 回调、且未被记录为移除的 GitHub 账号都会获得一条 `role = 'member'` 的 `users` 行，且不加入任何
  工作区——除非运维者关闭了 `signup_open`（关闭意味着不再新建行，已有行的登录照常登录）。
  已登录但没有任何工作区的用户会落在 **创建工作区** 表单
  （`POST /dashboard/api/workspaces`）：它生成小写的 `ws_…` 工作区，并在同一事务内把
  创建者设为该工作区的 `owner`。该表单始终渲染；当运维者关闭了工作区创建
  （`workspace_creation_open`）时，提交会被 409 `WORKSPACE_CREATION_CLOSED_REFUSAL` 拒绝，
  设置页只显示通用的创建失败提示。
  创建工作区是没有待接受邀请的登录进入工作区的唯一途径——同一个设置页也会列出待接受邀请
  并接受它——之后还可以通过角色变更转移所有权。创建成功后直接落在新工作区内（`201` 会给出
  `/dashboard/<ref>/apps`），因此不依赖「唯一工作区」解析能否在存在第二个工作区时命中。
  没有自动加入，也没有「首位用户成为唯一工作区管理员」的回退；此后权限一律按工作区判定。
- **部署接线去掉名单**：两个 workflow 只删除该白名单的必填变量门禁、部署后设置断言与
  它的 `--var` 传参；部署形态与运维者传参保留。自托管副本的手工部署直接用
  `wrangler deploy`。
- **工作区角色变更仅限 `owner`，所有权通过「提升」移交。** 角色变更现在也可以指向
  `owner`：现有 `owner` 把已在工作区内的 `admin` 或 `member` 提升为 `owner`，然后自行
  降级即可——没有单独的移交操作。`admin` 仍可邀请、撤销邀请、移除普通 `member`，但不能
  变更任何角色，也不能移除 `owner` 或另一名 `admin`（403——即使该 owner 是最后一名，
  也返回 403 而不是 409）。
- **最后一名 `owner` 不能被移除或降级**；唯一 `owner` 自我降级返回 409，已有第二名
  `owner` 后同样的自我降级被允许。移除最后一名 `owner` 同样返回该 409，即使操作者就是
  该 owner（它优先于通用的「不能移除自己」400）。`users.role` 不再参与任何工作区授权判定，
  也不会被写入。
- **移除成员只移除成员关系。** 退出工作区只删除对应的 `workspace_members` 行：账号
  （`users` 行）保留，因此该用户仍可登录、其创建的邀请仍在、可以被邀请进另一个工作区，
  也可以自行创建工作区。部署级的登录封禁（`removed_logins`）仍只由运维者动作写入，绝不
  作为工作区成员变更的副作用。
- **工作区 URL 使用不可变的 id。** Worker 发出的每个链接——外壳 boot 的 ref、运维支持
  落地页、创建目标、`/dashboard` 落地、onboarding 重定向、邀请发现、侧边栏兜底以及
  切换器的选项——现在都使用 `ws_…` 而不是可读 slug，因此重命名工作区不会让任何链接失效。
  `(slug = ? OR id = ?)` 解析与路径匹配判定保持不变：旧的 `/dashboard/<slug>/…` 链接
  仍然指向同一工作区，浏览器 URL 也不会被改写。
- **面向所有者的 slug 编辑入口已删除。**
  `PUT /dashboard/<ref>/api/settings/slug` 及其设置页卡片被直接删除（不是重定向）——
  路径片段不再是租户可改的值，该请求对所有角色都返回兜底 404。slug 的撰写移至平台运维台。
- **所有者改为重命名工作区名称。** 新增仅所有者可用的
  `PUT /dashboard/<ref>/api/settings/name`，接收 `{ name }`，去除首尾空白并受创建时的
  长度上限约束；工作区设置页以名称卡片取代原 slug 卡片。保存后顶栏切换器的标签即时更新，
  无需重新加载，也不会改写路径。
- **平台运维台撰写 slug。** 运维者可通过
  `PATCH /_internal_admin/api/workspaces/:id/slug` 设置工作区的可读 slug，校验规则与原先
  面向所有者的路由一致（字符形状、保留字、冲突，包括「slug 不得等于其他工作区的 id」），
  并在同一事务内写入一条 `workspace.slug.set` 审计行。工作区表格在名称旁显示 slug，
  并提供行内编辑操作。

### Fixed

- **审查 Check 在投递被接受时挂载，并在给出结论后立即收口。** Check 尝试现在在投递路径上认领并创建 `in_progress` 运行——在 `REVIEW_QUEUE.send` 之前，而不是位于消费方的准入块内——因此挂载不再等待队列与冷启动沙箱，被准入的消息也会找到一条已释放的行，而不是与创建者抢跑。webhook 最多等待挂载 2.5 秒；超过后照常入队，挂载在调用上下文上继续完成。若消息在挂载释放该行之前就被准入，消费方会在 250 毫秒后重试一次接管（仅当该行仍由投递持有者持有；正在运行的审查持有者与已冻结意图绝不重试），并可接管已静默 5 秒的投递持有者。已释放的挂载行带有两分钟的宽限到期时间，因此若无人接管，每分钟的协调器会在那时接手——而不是等到一小时窗口到期。在执行前就被跳过的投递——幂等命中、发布日志交接、App 暂停——会把已挂载的运行以 `neutral` 结清并写明跳过原因，而不是让它在一小时窗口到期时变红。结清按载荷的 head SHA（即挂载所用的提交，而非检出的提交）与挂载记录在行上、并随消息携带的投递标识定位——因此只会关闭自己那次运行的 Check，绝不会误关重复投递的那条（即使挂载超出内联预算、稍后才释放该行）——并且不会让该 head 退役：被重试或恢复的投递仍会认领新的 generation 并运行自己的审查。并发守卫拒绝只在最后一次（终态）拒绝时结清（并写明拒绝原因；前三次重试不结清，因此重复投递绝不会关掉正在运行的那次审查的运行），而之后被准入的重试仍会认领新的 generation 并获得自己的运行——neutral 结清不会让 head 退役。若该 App 的 Checks 客户端已经就绪，跳过路径会自己发送这一次更新；对已暂停的 App（其门禁要求零凭据/零 GitHub 调用），跳过路径只冻结意图，由每分钟的协调器在下一轮发送。被准入的消息通过同一套带围栏的认领接管该行（epoch 递增，执行截止收窄为 900 秒执行窗口），并用自己的 handle 就地收口该运行；若接管发生在 begin 预算耗尽之后，则把行重新释放，而不是把一个无人等待的 handle 返回出去。改动前的预发环境实测：挂载延迟等于排队延迟——四个 PR 分别为 10 秒、3 分 20 秒、16 分 45 秒与 15 分 31 秒；给出结论后的收口耗时 122 秒与 113 秒，因为七天里 85 次尝试中有 69 次记录为 `terminalize_outcome = 'no-handle'`：消费方从未持有 handle，其第 12 步的收口因此根本无法执行。被拒绝的挂载（没有 Checks 面、token/GitHub 拒绝、run id 写入失败）只产生一条经脱敏的 `check_attach_failed` warn，既不改变 `accepted` 应答也不影响入队；被接管方抢先完成的释放不算失败。同一 head 的重复投递、队列重投或 synchronize 事件仍不会创建第二次运行。
- **begin 预算在 attach 期间耗尽时，Check 不再等到执行期限。** consumer 的 2 秒预算可能在 create 与 attach 写之间耗尽，于是已创建的 run 被 attach、handle 却被交回一个无人等待的 promise，attempt 便挂在一份 900 秒的活租约上，无人能收口。改动前的生产数据：269 次 attempt 中有 108 次落在 `terminal - created = 904–965 秒`（即执行期限），615–900 秒区间为空。现在与 attach 之前的情形一样交回 recovery——run id 已持久化，reconciler 会直接接管该 run，约一分钟内收口，而不是等到期限。
- **已决定的 Check 不再空等 15 分钟执行窗口**：审查发布后，若某个 Check 的结论已冻结，而冻结它的写入方已静默两分钟，恢复流程即可接管该行，无需等 900 秒的声明到期。结论尚未决定的 Check 仍保留其声明直到执行截止时间，因此仍在运行的审查不会被抢先接管；接管的租赁 epoch 递增，会让先前写入方的迟到写入被拒绝。
- **Check 现在会带上门禁结论。** `checks.update` 把冻结的 title 与 summary 当顶层字段发送，而 GitHub 只从 `output` 读取，因此每次收口都只剩名字加结论，冻结文案（`Review gate met for <sha7> (round N): verdict "ship it", score 100 (floor 80; allowed: ship it).`）从未到达 PR。现已嵌套进 `output`，适配器自己的参数类型也改为该形状，不再自造 API 会丢弃的字段。
- **Check attempt 会记录收口原因。** `review_checks` 新增 `terminalize_outcome` 与 `terminalize_elapsed_ms`（迁移 `0052`，已在 review-lifecycle 规范中登记）：`completed` 仅当行内证明终态发送已落地（`observed = desired` 且意图已冻结、非 `in_progress`）；`handed-off` 表示 hook 返回但无此证明，涵盖 fence 拒绝的冻结与 `completeCheck` 无法确认两种情形——两者都会把 attempt 交回 recovery；另有 `budget-exceeded`、`hook-failed`、`no-handle`（begin 预算耗尽，consumer 从未拿到 handle）。此前这些出口只写 `log.warn`，导致撞到 900 秒执行期限才收口的行不留任何分支证据。
- **检查在审查开始时出现、并在发布后约一分钟内结束**：Check 尝试改为在准入时认领——在并发守卫接受消息之后、创建容器与克隆 PR 之前——使用投递携带的 head SHA 或 PR 头水位，因此冷启动沙箱不再掩盖一次运行最初五分钟的状态。若权威检出的提交与该认领不一致（处理期间发生 force-push），早期运行会以 `superseded` 关闭，并在实际检出的提交上重新认领；命中幂等的重复投递会先关闭其运行再 ack。认领现在位于既有 15 分钟执行窗口的开端（Cloudflare Queues 单次调用上限，既不放宽也不是可调项），因此该窗口覆盖容器阶段而不被拉长。
- **放弃终端 `checks.update` 时立即释放尝试，而不是等执行截止**：当消费方的 terminalize 预算耗尽、hook 抛出异常、检出的提交与已认领的 head 不一致，或发布日志的交接取代了本次审查时，生命周期只在尚未冻结任何结论时才写入兜底意图（`superseded` 失败或通用的未确认失败），且该条件写在 UPDATE 谓词里——已冻结的结论（例如来自发布证明的成功）及其精确摘要绝不会被覆盖。随后以 `remote-unconfirmed` 与第一档 60 秒退避把尝试交还恢复通道：不发送任何远端请求，若恢复通道已接管则为空操作。Check 恢复协调器新增独立的每分钟 cron（顶层 Worker 与每个具名环境都要声明），失败巡检与发布协调器仍保持十五分钟，因此被释放的尝试通常约一到两分钟后收敛（第一档退避 + 下一次每分钟触发），而不是在执行截止后的下一个整刻钟。放弃路径可通过结构化日志 `check_terminalize_budget_exceeded`、`check_terminalize_failed`、`check_abandon_released` 诊断。
- **审查发布后检查即完成**：terminalize hook 现在拥有独立的 10 秒预算（spec §7.10），不再与 begin hook 共用 2 秒上限，其 Promise 交给队列调用的 `ctx.waitUntil`，因此缓慢的 `checks.update` 会在调用返回后继续完成，而不会随 isolate 一起被回收。PR 不再需要等 15 分钟的恢复 cron 才看到检查结束；超时会记录一条 warn，且不会阻塞审查。
- **Both Check budgets are operator settings**: the terminalize wait and the bounded `checks.update` now come from `review_runtime_settings` (`review.check.terminalize_timeout_ms`, `review.check.update_timeout_ms`), read once per message and editable on the Runtime console page with one audited save. The former source constants survive only as the documented absent-row defaults (10 s for the inline wait, 5 s for the single `checks.update` send), and a save is refused unless the inline wait exceeds the configured send budget — the rule is relational, so raising the send bound raises the wait it requires. The pipeline no longer depends on a redeploy to bound a slow Check.
<!-- CN -->
- **两个检查预算改为运维配置**：terminalize 等待与受限的 `checks.update` 现在读取 `review_runtime_settings`（`review.check.terminalize_timeout_ms`、`review.check.update_timeout_ms`），每条消息读取一次，并可在 Runtime 控制台页面通过一次带审计的保存修改。原源码常量只保留为文档化的缺行默认值（内联等待 10 秒、单次 `checks.update` 发送 5 秒），且保存时内联等待必须大于所配置的发送预算——规则是关系性的，调高发送上限也会相应抬高所需的等待值。流水线不再需要重新部署才能约束缓慢的 Check。
- **未真正到达 GitHub 的 Check 拒绝不再消耗一次 recovery attempt，因此一次瞬时 token mint 失败不会再把运行中的 Check 判死。** reconciler 过去把每一次 `unavailable` 的读取或更新都记成一次失败尝试；连续五次凭证 mint 失败就会把活着的 attempt 推到 `local-error`/`terminal_ms`——选择器此后永不回看——而 GitHub 上该 run 仍是 `in_progress`。生产实测：一条 Check 挂了四个多小时，`last_error` 为 "gave up after 5 attempts … no review-write Checks client for this App"。读取与终态更新的「可证明零派发」拒绝现在与 create 通道一致，在身份栅栏下交还 claim：不计 attempt、不设退避、立即重新到期。凭证解析自身的脱敏文本也进入 reason，`last_error` 因此能指出原因，而不是把所有失败压成 "no client"。
- **真正跑满执行窗口的 Check 行为不变**：确实派发过并耗尽窗口的 attempt 仍在期限处收尾。
- **持久化 scope 之后被改名的仓库，不再永久冻结 Check。** GitHub 对 token 的 `repositoryNames` 做精确匹配，而 REST 路径本身会跟随改名，于是旧名让每一次 scoped mint 都 404，而持久化身份又是不可变的。生产实测：某个仓库在几分钟前改名，其 PR 上的 Check 挂了四个多小时仍是 `in_progress`。`review-write` 的 mint 现在在 404 时重试一次，仍用同一 installation、同一权限集，只是不再按仓库收窄；`sandbox-read` 保持 fail-closed。
- **等待发布证明的检查不再越过该次尝试自身的截止时间**：检查尝试在等待发布证明期间会把认领（claim）交还，并把到期时间设为首个退避档位——现在这一到期时间被钳制在该次尝试的执行截止时间上。此前若截止时间落在该档位之内，该行在档位走完前都不会被选中，PR 的检查会停在 `in_progress` 超过本应结束的最后期限。现在该行在截止时刻即到期，并在之后的第一趟对账中得出结论。
- **一条机器人提及评论最多触发一次审查**：`issue_comment` 作业现在携带该评论自身的 id（`comment_id`，来自 `comment.id`），并在入队**之前**写入一行 `comment_trigger_claims`（迁移 0048_comment_trigger_claims.sql）——拒绝第二次投递的是该行的主键，而不是 KV 的 get-then-put：无论是并发投递，还是在 KV 快路径 24 小时 TTL 过期之后到达。流水线会在任何昂贵步骤之前原子地消费该行，因此队列重投、outbox 重发或重复投递都只确认而不启动第二轮审查。发送失败会删除该行，让 GitHub 的重试可以重新声明；若在写入与发送之间崩溃，cron 扫描会重发超过重试窗口的 `queued` 行，并把达到尝试上限的声明置为 `expired`。已消费的声明永不再执行：失败的评论触发审查通过发布新评论（新 id）重跑，而不是重放。缺少可读评论 id 的作业行为完全不变。重试窗口、尝试上限与单轮重发上限是 `review.comment_claim.*` 下的运维设置（admin runtime 页面），默认 300000 ms / 3 / 20。
- **应用详情页「最近投递」面板以审查结论优先**：该面板原为原始「最近 5 条」时间线，而旁路事件（`check_run`、`ping`）比审查流量高几个数量级且恒为「已忽略」，五行全被它占满，健康的 App 也看起来卡在「已忽略」。现在按与应用列表健康列相同的结论分层排序（`ok` / `paused` / `rejected` 优先于 `ignored`），层内仍按时间从新到旧；存储行不变，仅有旁路流量的 App 也照常列出最新几条。面板说明文案不再声称「最近 5 次投递」。
- **部署工作流现在会传递平台运营 allowlist。** staging 与 production 部署都会读取 `PLATFORM_OPERATORS` 仓库变量并写入 Worker var；此前工作流从不读取它，导致 `/_internal_admin` 对任何调用者都返回 404。
- **PR diff 现在真正到达 Worker。** diff 步骤把 `gh pr diff` 重定向到
  `/workspace/pr.diff`，读取的却是 *exec 的 stdout*——重定向后它必然为空，于是
  可信证据目录是用空字符串构建的，每个被选中的历史问题都被判为不可证明，整轮只能
  对从未展示给 seat 的行发布 `unverifiable (no-evidence)`。该命令现在既写文件
  （仍是 numstat 的来源），又通过与 recheck 文档相同的受限通道读回：前 2 MiB，
  随后是 `wc -c` 溢出标记。超限仍不产生切片、行内评论退回 base 过滤，整轮从不丢弃。
- **无法证明任何行的 diff 捕获如实上报，而非伪造结论。** 空捕获要与同一轮的 numstat
  对照判断：读不到任何内容而 numstat 显示有 diff，是捕获失败；两者都为空则是真正
  无改动的 PR，属于正常一轮而非丢失捕获。超限的 diff 存在却无法证明任何行；读回
  缺少标记行则说明通道损坏。以上情况都让整轮标记为 `context-incomplete`，并打出
  `diff_capture: "empty" | "overflow" | "unreadable"` 警告，而不是为每一行发布
  看似确定的 `no-evidence`。
- **空 diff 现在直接确认，而不是让评审失败。** 对空的 diff 文件，`git apply
  --numstat` 会把它当作无法解析的输入而拒绝，于是 `base..head`（或整个 PR）没有
  任何改动的轮次在 sandbox 阶段失败并被重试。现在由同一轮对该文件的读取来判定这个
  退出码：空文件按既有“无改动”结论确认——不发布、不写评审行、不写失败行，首轮
  （`review_no_diff`）与空增量（`review_no_increment`，并让 Check 继续继承上次已
  评审的 head）都是如此；其它非零退出仍然失败，并同时给出 git 的 stderr 与 diff
  文件状态。
- **Git 阶段失败不再回显凭据**：diff、增量 diff 或 numstat 步骤失败时，上报的 stderr 尾部除了按形态抹除凭据样式的文本，还会精确抹除本次会话实际使用的密钥值——不匹配任何形态规则的凭据也不会随失败消息进入日志或持久化的失败记录。
- **洞察图表按实测宽度渲染**：不再把固定 560px 的 SVG 拉伸到宽卡片上（导致设计好的刻度文字被放大）——宽度由 ResizeObserver 实测容器获得，静态/SSR 与不支持 ResizeObserver 的 WebView 仍使用固定尺寸。
- **图表日期标签固定为数字 M/D 格式**：所有语言共用同一格式，不再随应用语言变化。
- **洞察趋势卡现在与所选窗口的桶粒度一致**：7/30 天窗口读取新增的按天趋势序列（零填充日桶）；90 天窗口保持周桶，并按堆叠图所用的同一网格零填充——趋势图与分布图的桶计数始终一致。
- **过大的增量抓取现在降级为整份 diff 的轮次，而不是让评审失败。** 复审轮次通过
  compare API 抓取增量，而它执行与 `gh pr diff` 相同的 20,000 行上限，因此较大的
  `base...head` diff 会被拒绝，并让 sandbox 阶段每次尝试都失败。现在增量的返回先落到
  临时文件，只有真正拿到结果才替换本轮已有的整份 diff；被拒绝的情况会被分类：本轮
  记录一条结构化警告，写明原因与停在哪一步，并丢弃 `since` 事实（不再保留该 diff
  已不支持的说法），改为评审本轮早就抓到的整份 diff。其它任何增量失败仍然失败，并
  保留各自独立的原因（退出码、脱敏后的 stderr 与 diff 文件状态）。
- **此前轮次已判定的会话会在后续轮次重新验证后自动解决**：Inspector 自己的发布评论（bot 作者、正文以 review/degraded 标记开头）不再计入抓取的 issue 讨论，模型上下文、抓取时摘要与解决侧摘要因此共享同一域，发布评审不会再让它自己验证过的快照失效。recheck 轮换现在还会选中仍然持有未取代且未终结关联（`pending`、`retry`、`needs-recheck`、`local-error`）的 `addressed` finding——seat 会在真实轮次中按**当前** HEAD 与讨论重新核验这些关切，再由常规解决通道用本轮自己的已验证快照解决。关联变为 resolved/abandoned 后该 finding 退出轮换；每条被选中的行仍会推进 `last_scheduled_ms`（不会饿死后面的行）；覆盖统计把扩展后的集合计入（`totalOpen` = 可复查行数），已发布的 `assessed + invalid-output + omitted = selected` 恒等式保持成立。解决栅栏改为要求 finding 仍为 `addressed` 且本行自带 addressed 判定，而不再要求 `last_publication_id`——因为已判定行再次被评估时 seen upsert 不会更新其 publication。取代、所有权、覆盖、HEAD/对话/issue 摘要栅栏与变更确认全部保持不变，因此复发、被取代的关联或人类回复依旧失败关闭。
- **被限流的 provider 校验现在如实说明，而不再猜测账户已欠费。** 密钥校验对 429 返回独立原因 `rate_limited`：provider 限流了本次请求，未对密钥作出判断，未存储任何内容。429 的响应体完全不再读取 — Gemini 对单纯的限流和真正耗尽的额度都返回 `RESOURCE_EXHAUSTED` 与 “Quota exceeded. Please check your plan and billing details”，从外部无法用任何词面区分两者。现在的判定阶梯是：401/403 → `invalid_key`（403 的账单限制仍表示“该密钥不能做这件事”），402 → `quota_exhausted`，429 → `rate_limited`，其余非 2xx 仍走既有的 credits/quota/billing 响应体判定 → `quota_exhausted`，否则 `unexpected_response`。本条同时引入两个此前不存在的判定：`quota_exhausted` 本身，以及 402 与“错误体指明 credits/quota/billing 的非 2xx”这两种情况 —— 在本改动之前分类器只有 `invalid_key`、`unreachable`、`unexpected_response`、`unsupported_provider` 四种结果，这两类都会被报成 `unexpected_response` 或 `invalid_key`。内置 models 端点、内置探活与自定义 provider 探活这三条验证路径仍共用一个分类器。中英双语都补上了新文案：说明本次请求被限流、未对密钥作出判断，并在账户确实耗尽时保留额度耗尽这一可能原因。
- **发布响应丢失时改为正常恢复，不再一路退避**：当审查评论的发送结果未知时，恢复流程会重读 PR 会话，寻找可能已经发出的那条评论。该读取此前会过滤掉 Inspector 自己发布的评论——恰恰就是它要找的那条——于是每次尝试都报告「未找到完全匹配的发布」并持续退避直至尝试上限，已发布的评论因此停留在未记录状态，只能由运维人工排查。现在该读取可按调用选择包含自身发布，且只有这条恢复通道这样做；讨论摘要与模型上下文的域保持不变，未变更的 PR 在改动前后摘要逐字节相同。
- **每一次失败的复核轮次都会说明原因**：单行的 `error` 不再越过席位归因链，被拒绝的席位调用也会保留已结束子进程的中止原因、stderr 尾部与退出码；两条失败出口共用同一条归因链（`structuredOutput.error` → `abortReason` → `error` → stderr 尾部 → 退出码），不再只给出一句 seat-failed 文本。
- **单行不合格不再丢弃整轮重审。** 重审文档校验现在区分两级不信任。文档级故障
  （schema 错误、HEAD 过期、`results` 非数组或超出上限、重复行 ID、行 ID 不在
  targets 内）仍然整份文档失败。行级内容故障现在只丢弃该行：它进入 `rejected`，
  worker 将其呈现为 `unverifiable/invalid-output`，其余行正常被接受并发布。
  此前一处不精确的引用会连带丢弃该轮所有其他评估。
- **引用比对宽容格式噪声。** `addressed` 引用现在按规范化后比对——CRLF/CR→LF、
  逐行去尾随空白、去掉一个尾随换行——而不再要求逐字节相等，因此不可见的尾随
  空白不会再让正确引用失效。其他资格规则不变：行号范围、slice 归属与完整性、
  原始范围相交、结构变更要求仍然生效——并且 `removed-code` 的「旧行已从新侧
  消失」判断同样规范化，因此对仍然存在的代码多加一个尾随空格，再也无法伪造
  一个从未真正修复的结案。规范化永不挽救空白引用：纯空白的 `quote` 会规范化为
  `""`，与空白的被引用行逐字节相等，因此现在直接拒绝，1–4096 的上限也只统计可见
  字符。
- **丢失的重审轮现在可归因。** 席位在每条退出路径上都会写出有界的
  `mstar.recheck-status/v1` 文档——`ok` 携带被拒行 ID 与行数、预算不足时
  `skipped`、失败时带上有界的 reason/error——worker 会在读取文档的同时读取它。
  因此即使容器 stderr 已丢失，未产出可用文档的轮次也会写入一条
  `stage: recheck` 的 `review_failures` 行和一条 D1 日志。席位写出的是已过滤
  的文档，所以正是状态里的 `rejected_row_ids` 让这些行保持
  `invalid-output`，而不是被静默算作 `omitted`；状态 `error` 先脱敏再截断，
  跨过截断点的密钥不会再以碎片形式留存。
- **重审席位现在明确了引用方式与上下文缺口的影响范围。** 其 assignment 现在要求
  从输入文档 `evidence` 目录中**逐字复制**被引用行，而不是凭记忆重打；截断
  只降级依赖缺失上下文的那部分结论，而不是整轮所有行。
- **预算跳过的轮次不再被记成无效输出。** 席位自己写的 `skipped` 状态现在把每个
  选中行记为 `unverifiable/budget`（根本没发送），而不是 `invalid-output`
  （发送后被答坏）；worker 在解析时就把状态的 `reason`/`error` 截断，因此 D1 的
  失败文本与日志字段是同一个上限值。worker 自己的 §7.3 尺寸预算同理：被预算排除在
  输入之外的行同样从未发送，因此即使没有文档也应记为 `budget`——并且该轮仍会输出
  自己的账目行，点名这次排除，而不是把每一行都静默记成无人应答的
  `invalid-output`。别的 HEAD 写下的状态、或点名了本轮从未发送的行的状态，都不产生
  任何归因。
- **runner 主动取销的一轮不再被记成失败。** 主评审一结束，runner 就会中止尚未完成的
  重审席位，因此该轮之所以什么都没回答，是因为它被停止，而不是因为它运行后失败了。
  这次中止现在报 `skipped`、reason 为 `aborted`，而不再是 `failed`/`seat-failed`：
  worker 不写 `review_failures` 行，所有行保持 `unverifiable/omitted`，轮转时钟不动；
  而真正的席位错误或非 `Error` 拒绝仍然报 `failed`/`seat-failed`。
- **重审文档写失败会被记录，而不是被掩盖。** runner 只有在文档写成功之后才写轮次
  状态；文档写失败时以退出码 1 结束且不输出 stdout（走 worker 的 runner 失败路径），
  因此不会有任何状态把从未送达 worker 的文档报成 `ok`，D1 也不会再把「什么都没发布」
  的轮次留成干净记录。状态错误的脱敏使用 worker 同一份凭据模式表
  （`packages/shared/src/secret-shapes.ts`——两侧共用唯一一份列表）。
- **整轮什么都没交付时状态报 `failed` 而非 `ok`。** 当校验接受了文档、但没有任何一行
  提交行通过时，状态为 `failed`，reason 为 `all-rows-rejected`，因此 worker 会写入
  自己的 `review_failures` 行，而不会把「什么都没交付」的轮次留成干净记录。若文档
  合法、目标非空、却零结果（没有任何行被校验丢弃），那是同一种失败，现在报
  `failed`，reason 为 `empty-result`：该轮可归因，且它发送过的行记为
  `invalid-output`（答坏了），绝不算作 `omitted`（从未运行）。部分行被拒仍是 `ok`
  并携带被拒行 ID。读取时 `rejected` 计数由 `rejected_row_ids` 推导，两个计数面
  不可能互相矛盾。
- **`current-code` 结案必须引用本次变更「新增」的行。** 此前一条未改动的上下文行也能
  证明修复：引用逐字匹配、范围落在 hunk 内，于是引用变更前的代码就把该行结案了。证据
  切片现在携带 `addedNewLines`（该 hunk 中 `+` 行占用的新侧行号），`current-code`
  引用必须命中其中之一；只证明「代码还在」的引用会随行丢弃为 `invalid-output`，
  真实替换则引用 `replaced-code`——它的旧侧证明本来就要求代码确有变更。
- **empty-result 轮次不再为从未发送的行计费。** 该判定此前覆盖所有未应答行，因此被
  可信目录无法证明的行（或其切片输给了目录字节预算的行）即使席位从未收到，也会推进
  轮转时钟。现在只有真正上过线的行才是 `invalid-output` 并计入已尝试；目录排除的行
  保持 `no-evidence`，目录预算排除的行保持 `budget`，两者的时钟都不动。
- **「旧行已消失」按行判定。** `removed-code` / `replaced-code` 的守卫不再在拼接后的新侧
  块里搜索拼接后的引用：在被引用块中间插入一行会打断整块，从而伪造出一次删除。现在只按
  被引用范围**自己**在新侧对应的那段行判定（包含块内插入的行），要求每一条非空白的
  规范化被引用行都不在其中：插入因此仍然不能证明任何删除，而真实替换可以通过——范围内
  残留的相同上下文行、以及仅仅在 hunk 别处重复出现的同一段文字，都不会再让它看起来
  「还在」。
- **尺寸预算按真正上线的输入判定。** §7.3 字节预算此前用所有候选行的证据来衡量每一行，
  其中包含本轮即将被丢掉的行，因此早先被排除的行即使证据集随后缩小也再也回不来。现在
  每一行只用已接受的行所带的证据来衡量：被丢弃的邻居不贡献切片，唯一被排除的是确实放不进
  最终输入的行。
- **状态 `reason` 是封闭词表。** 只接受 `budget`、`aborted`、`all-rows-rejected`、
  `empty-result`、`seat-failed`、`invalid-document`（两侧共用一个常量）。worker 的逐行
  账目正是按这些字面值分支，因此词表外的值在读取时被丢弃，而不是静默走进某个分支。
- **丢失的重审文档会说出真实原因。** 席位报告 `ok`、但文档在读取侧失败（缺失 / 超出上限 /
  校验失败）时，此前会写入 `error: "ok: null: null"`；现在读取原因排在最前，且零字节的
  文档读作 `absent`：席位什么都没写，因此不会把它从未产出的负载格式错误算到该轮头上。
- **过期的丢弃记录不再抹掉真实答案。** 当状态点名了某行、而存活的文档也给出了该行的答案时，
  以答案为准，而不是覆盖成 `unverifiable/invalid-output`。
- **发布覆盖行只统计席位真正给出的回答。** 被校验丢弃的行是「已尝试」的，轮转时钟
  （`last_assessed_ms`）照常前进，但它从未被真正评估：覆盖行与该轮的账目日志字段
  只统计携带文档结果的行，一轮再也无法声称席位从未交付的重审数量。生命周期时钟
  仍然包含已尝试的行，因此公平轮转不变。每个被选中的行只会落在其中一个条目下——
  `assessed`、`invalid-output` 或 `omitted`，即 `assessed + invalid-output + omitted
  = selected`——中间一项正是闭合表使用的标签，所以覆盖行与表格行不会互相矛盾。
  校验丢弃且没有可用行 ID 的行，按其位置归到已发送但无回答的那一行，而不是报成
  `omitted`；状态现在携带 `rejected_unnamed`（一个计数——这种丢弃无法被命名），
  因此即使文档已被 runner 过滤，归因依然成立。该计数由席位自述、没有上限，因此会被
  夹到它合法能声称的行数（已发送、无回答、未命名）；超出的部分被忽略，并以
  `rejected_unnamed_ignored` 记录，绝不会摊到席位从未收到的行上。
- **超大 hunk 内的 finding 仍保有局部证据。** 超过 80 行切片上限的 hunk 不再被整体
  排除（那会让它内部的每个 finding 永久成为 `no-evidence`）：它按连续 ≤80 行切成
  多个窗口，离原始关注行最近的优先，每个窗口的起始行号直接来自 hunk 头的行号算术。
  窗口内的引用可校验通过；窗口外的引用仍然失败。
- **`recheck` 与 `usage` 失败不再触发告警。** 定时失败扫描此前统计窗口内所有
  `review_failures` 行——查询没有任何 stage 条件，且 `recheck` 当时还不是可选
  stage——因此两类归因行都可能为正常发布的评审唤来 on-call：预算跳过 / 席位失联 /
  文档无效的重审轮，以及用量事件写入失败但评审继续的轮次。现在两个阶段都在告警
  统计之外，也都不计入单个 PR 的失败数量。单个 PR 的失败历史两者都会列出，让丢失的
  计量记录和「未产出可用文档」的重审轮在 App 详情页各自保有可见面。阶段清单只在
  `src/contracts/failure-stages.ts` 写一次，并插值进扫描与仪表盘查询；失败历史
  查询完全不带 stage 条件。
- **复核轮次能在预算内完成**：复核席位改用所属审查档位自身的墙钟（quick 300 秒、default 600 秒、deep 900 秒），不再使用会在读取途中杀掉它的固定 180 秒；该墙钟再以外层守卫减去 60 秒发布尾部为上限，因此实际生效的上限为 300 秒、540 秒和 780 秒。失败轮次的状态错误现在会记录子进程的 `abortReason`、stderr 尾部或退出码，超时可直接从 D1 归因，而不再只有一句 `unavailable`。
- **大型重审轮现在按席位的上下文预算来提问。** 此前席位的 assignment 会原样嵌入整份
  `mstar.recheck-input/v1` 文档——最高可达 512 KiB 输入上限、约 131k–150k token 的 JSON——
  于是大轮次索要的提示远超一次性席位可靠容纳的量，`yield` 永远不会到达
  （`failed / seat-failed`、状态 `unavailable`；I-000396）。现在提问被裁剪到有界预算内：
  所有 target 与 discussion 始终保留，证据切片在预算内原样保留——先保证每行一个切片，
  因此裁剪只会饿死预算从未覆盖到的行，绝不会因为排序而饿死后面的行。证明未被保留的行，
  席位被要求回答 `unverifiable`/`context-incomplete`，绝不允许没有保留证据的 `addressed`；
  并且校验以席位实际收到的目录为准，引用被裁剪切片的行会按行名丢弃，不会被当作
  `addressed` 发布。文档级校验与严格输出 schema 均不变。
- **无法提问的轮次会被记录，绝不照样派单。** 当仅 targets 加 discussion 就超出预算时，
  不会启动任何席位：该轮报 `skipped`/`budget`，附带点明所需与可用字节数的有界错误，
  worker 因此把每个已发送行记账为 `unverifiable/budget`，而不是把 180 秒窗口花在一次
  注定空手而归的调用上。
- **提问预算是运维可配项。** `review.recheck.assignment_max_bytes`（默认 `65536`，
  范围 `8192..262144`）是运维控制台上的系统运行参数，每轮读取一次并作为 runner 顶层
  输入字段传入——冻结的 `mstar.recheck-input/v1` 文档不变。窗口更大的模型因此无需重新
  部署即可承受更大的提问。
- **被移除的登录无法被重新创建**：登录自己的建行逻辑（`signInCreateUser`）带有 `WHERE NOT EXISTS（移除记录）`，因此 OAuth 回调无法为 `removed_logins` 中记录的登录创建 `users` 行。
- **墓碑作用于在线账号时阻止的是新建邀请，不是登录**：仍然存在 `users` 行的登录可以继续登录并保留成员关系，墓碑之前发出的待接受邀请仍可被接受；只有新建邀请会被拒绝。在该行被删除之后，登录才会被拒绝。
- **移除没有产品内入口**：任何 owner 都无法撤销墓碑。邀请接口会返回 409 `invite.login_removed`（dashboard 只显示通用的邀请失败提示），而唯一会清除墓碑的写入者（`createUser`）没有生产调用者——墓碑由部署运维者直接在 D1 中维护。**退出工作区不是移除**：那只会删除 `workspace_members` 行，账号、既有邀请与 GitHub 登录均不受影响。
- **持久化的 runner 失败文本现在按真实 UTF-8 字节数报告 stdout。** `runnerFailureDetail` 之前用 `String.length` 加 `B` 后缀，因此输出过非 ASCII 内容的 run 会被低估——按 UTF-16 代码单元计数，而不是 UTF-8 字节。现在与相邻的 git 阶段详情一致，统计方式相同；stdout 为空时仍显示 `0B`。
- **runner 输入改走 exec 的 stdin 管道**：`--input` 文档不再拼进 shell 字符串，而是以 base64 写入容器步骤的 stdin（`base64 -d > '<路径>'`）。当评审轮次的发现足够多时，编码后的文档会超过 Linux 单参数 128 KiB 上限，`execve` 返回 `E2BIG`，此后每一轮都在 `stage=sandbox`、`timeout` 尚未启动时失败。写文件步骤非零退出仍会判定该轮失败。
- **接近单参数上限的命令直接拒绝，并给出可读错误**：`runCommand` 在启动容器或任何进程之前，按 UTF-8 字节测量命令与各 env 值，命令超过 96 KiB（env 单值 8 KiB）即拒绝。错误信息只给出实际大小与上限，不回显命令内容，因此超限步骤可以定位到功能本身，而不再是平台的 `E2BIG`。
- **沙箱镜像不再从 GitHub 的 release 资产 CDN 获取工具链。** `github.com/…/releases/download/…` 对 Bun 与 gh CLI 资产返回 `504`，导致镜像构建失败，进而使 staging 部署失败。重试无法恢复：从构建网络发出的 8 次尝试全部返回 `504`，而 `github.com`、`codeload` 与 `git` 均正常。Bun 改从官方 Docker Hub 镜像按 digest 固定复制（仍为 1.4.0，以 `bunImageDigest` 与 `bunVersion` 一并声明），gh 改从 GitHub 自己的 apt 源安装。Docker Hub 本就是该 Dockerfile 的硬依赖——基础镜像与 sandbox shim 都从那里复制。
- **gh CLI 有意从 GitHub 的 apt 源非固定安装。** 2026-11-08 对该源的四次探测中，2.98.0 与 2.103.3 可解析，2.90.0 与 2.80.0 返回 404，说明旧版本在该源上并无可靠的长期可获取性，把版本写进文件名的 URL 可能让未来的冷构建变成 404。镜像因此安装该源当前提供的版本，并把解析到的 `bun`、`gh` 版本写入 `/etc/mstar-image-versions`——仅构建日志无法从运行中的执行器查询。`gh` 是唯一未记录在 `OMP_SANDBOX_IMAGE_PINS` 中的构建输入，该取舍写在类型注释里。
- **镜像中移除 `unzip`。** 它原本只用于解开 Bun 的 release zip，而该 zip 已不存在；文件中没有其他解包动作。
- **参数异常的拒绝响应不再在设置页打印 `[object Object]`。** 映射型 400 响应体的两个读取点——共享的设置/固定项操作解析器与密钥校验路径——此前仅凭 `typeof === "object"` 就把 `params` 断言成 `Record<string, string | number>`，于是当服务端返回的参数值是对象或数组时，本地化句子会把 `String(value)` 插进去（`[object Object] 不是受支持的 provider…`），或留下未填充的 `{provider}`。现在只有每个值都是字符串或数字时才接受该参数表；否则该读取点放弃 keyed 文案，改渲染自己的通用提示，绝不回落到原始 JSON 响应体。
- **仪表盘外壳固定在视口内。** 侧边栏与顶栏不再随页面滚走：外壳与内容区均为视口高度且不滚动，只有页面主体是唯一的纵向滚动容器。窄屏仍保留流式侧栏列。
- **打印仪表盘页面不再被裁成一屏。** 固定在视口内的外壳在屏幕上仍保持侧边栏与顶栏不动，但在打印媒体下解除固定高度与隐藏溢出，打印输出会延展到完整内容。
- **审阅线程恢复绑定与解析**：两处身份/锚点形状不一致，曾让每一条关联永远停在 `pending`。GitHub 通过 REST 把本 App 自己的登录名报成 `<slug>[bot]`，而 GraphQL `author.login` 只给裸 `<slug>`，所有权比较却只认带后缀的形式——于是每次发现都判成 `unknown`/`foreign`，thread、comment、review 三个 id 从未被写入。线程所有权与 review 存根身份现在同时接受同一身份的两种形状，并仍要求 `Bot` 作者类型；只读发布恢复则完全不再信任登录名文本——复制的正文不构成作者证明——改用 GitHub 在抓取到的评论上给出的已认证「查看者即作者」标记，因此与 App 同名的人类账号无法通过。另外，新建行审阅返回的评论改为按评论正文中可信的线程标记匹配到对应 finding，因为该端点返回的 `line`、`original_line`、`side` 全为 null；路径+行号锚点只作为没有可读标记时的兜底，未知或重复的标记绝不凭空构造映射。端点不变，请求次数不变。
- **评审会话现在可以收尾**：复查轮会在抓取讨论之前，先绑定每条既有发现对应的评审会话；因此即使最初的发送响应丢失、没有存下会话 id，该对应关系也能获得经过验证的解决结果，而不是一直保持未关闭。该过程每轮审查有上限，未能覆盖到的对应关系会留待后续轮次。新建行内评审的评论 ID 改为从该评审自身的 comments 连接读回——GitHub 的 create-review 响应不带 comments 数组，没有这些 ID 就无法把已发布的评论匹配回对应发现。读取失败只会让捕获保持未确认，不会让整轮审查失败，也不会凭空编造结果。
- **触发模式选择在保存成功后立即回显**：应用设置的触发模式控件不再在保存成功后高亮滞留旧值——保存请求成功返回（成功即已写入）后新模式立即高亮，不再等待后台刷新；保存失败时仍会从已存模式重新同步。
- **Escape 关闭你最后打开的那个用量面板**：即使重渲染为该面板换上了新的关闭回调，Escape 依旧关闭最后打开的面板。
- **工作区 `check_min_score` 审计记录工作区实际生效的下限。** 此前即使存储值不可读、
  从未生效，账本的 `before` 也会写成平台默认值（60）。现在读取方不信任的任何值都记录为
  缺失状态（`null`），账本只记录工作区真正运行过的下限。
- 当工作区的默认评分下限无法读取时，连接 GitHub App 不再显示笼统的“数据库拒绝了写入”：连接页面会指明无法读取的是工作区设置、说明未存储任何内容，并链接到工作区设置页面，修复后重新提交即可。真正的数据库故障仍保留原有提示。
- **部署存在多个工作区后，App 创建仍然可用。** 创建权限现在按请求所指工作区判定
  （在该工作区为 `owner`/`admin`），而不再依赖在出现第二个工作区时就不存在的「部署唯一
  工作区」。SPA 的创建按钮提交到当前页面的工作区前缀，所选工作区随签名 state 与加密
  hold 一路传递，因此 App 落在操作者开始流程的那个工作区。多工作区部署上未指明工作区的
  请求现在返回 `409 {"code": "workspace_required", …}`（页面导航时返回同款错误页），
  而不是裸 `403`。
- **创建按钮不再静默消失。** 调用方无法执行该流程时，SPA 显示禁用的控件并给出原因——
  当前工作区的角色，或缺少工作区——两种语言均有文案。
- **`/dashboard` 落到真实路由。** 拥有多个成员关系的登录会跳转到其第一个工作区（成员
  关系按名称、再按 id 排序）的 Apps 页，而不是已退役的 `/dashboard/apps`，侧边栏导航
  也跟随该工作区。
- **运维审计顺序测试变得确定。** 同一请求批次写入的 `audit_events` 行共享毫秒级时间戳，
  因此测试改用 `rowid`（写入顺序）而不再用随机 UUID 主键打破并列。

### Removed

- **破坏性变更——部署级审查总闸已删除。** `REVIEW_ENABLED` Worker 变量不再存在：
  没有读取方、没有 env 声明、没有文档表格行、没有 `keep_vars` 说明、没有测试夹具。
  唯一的审查控制是 per-App `github_apps.review_enabled`（dashboard 的 Pause/Resume
  开关），任何部署级取值都无法冻结全部租户的审查。除此之外行为不变：
  `review_enabled = 1` 的 App 收到 webhook 会入队，`0` 的 App 返回 2xx 且零入队。
- **仍保留 `REVIEW_ENABLED=false` 的部署，会在本次 Worker 上线的那一刻恢复审查——
  除已经暂停的 App 之外。** 该值已无读取方，因此再也冻结不了任何东西：
  `review_enabled = 1` 的 App 会在下一次 webhook 时开始真实审查，而已处于
  `review_enabled = 0` 的 App 仍然保持冻结。**部署之前**，请对每个你要继续保持冻结的
  App 施加三种停止手段之一：暂停它（在其 dashboard Settings 页把 `review_enabled`
  置为 `0`）、在 dashboard 中停用它（`POST /apps/:slug/disable` 会置
  `status = 'disabled'`，停用的 App 在 webhook 面返回 404），或在 GitHub 侧 suspend
  该 App。不存在部署级总闸。**升级提示：** 请删除残留的 `REVIEW_ENABLED` Worker 变量
  （以及可能设置过的同名 GitHub Actions 变量）——已无任何读取方，留着只会暗示一个
  已不存在的控制手段。

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

