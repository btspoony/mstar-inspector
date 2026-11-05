---
category: Added
---

- **Per-App review gate — the Check now reports a gate, not execution
  completion.** The `mstar-inspector review` Check run concludes `success` only
  when the published review's verdict is one of the App's passing verdicts
  **and** its tally score is at least the App's floor; the defaults are the
  verdict `ship it` and a floor of 60; an App connected from now on starts at
  its workspace's default (60 unless the workspace chose another), while an App
  that predates the change keeps the floor it already stored — every App that
  existed when the gate column was added carries the 80 that migration `0045`
  materialized, and nothing moves it to 60. A confirmed degraded
  publication, an unconfirmed or expired attempt, an execution failure, a
  published review below the bar, an unreadable App gate and a published review
  without a readable tally all conclude `failure`; `neutral` is no longer
  produced (it survives only in historical rows). The review is read by the
  attempt's own publication id, so a row belonging to another attempt for the
  same commit cannot decide it, and a missing payload fails the gate instead of
  falling back to that row. The summary names the verdict, score, floor and
  allowed verdicts whenever the gate decided the outcome; the run still
  carries no `details_url` and is still never an approval or a merge gate.
- **The gate is App configuration on the settings page.** A *Review gate*
  section saves the floor (a whole number 0–100) and the set of passing
  verdicts (the engine vocabulary: `ship it`, `needs fixes`, `blocked`,
  `incomplete`). An off-vocabulary verdict or an out-of-range score is a keyed
  400 with zero writes. An empty verdict set is legal and fails closed — no
  review can ever pass, and the page warns before saving. A change applies to
  the next Check with no deploy. Migration `0045` is additive: existing rows
  materialize the defaults, so no backfill or settings visit is needed.
- **The floor a new App starts at is a workspace setting.** The workspace
  settings page gains a *Review gate default* card (`workspaces.check_min_score`,
  migration `0049`); connecting an App seeds its floor from that value, and the
  platform default is 60. Existing Apps keep their own stored floor — the
  workspace value is a default, not a backfill — and the per-App *Review gate*
  section remains their writer.
- **Owner allowlist on the Installed tab — off by default.** With the switch
  off nothing is filtered: every owner is reviewed as before. With it on, the
  App reviews only deliveries whose `repository.owner.login` it lists, on the
  `pull_request` trigger and the `issue_comment` mention alike; logins compare
  case-insensitively and a case variant collapses onto the first submitted
  spelling. The list is replaced on every save, accepts at most 100 owners, and
  each entry must be a valid GitHub login — otherwise a keyed 400 naming the
  offending entry, with zero writes. An enabled list that is empty is legal and
  refuses every owner (fail closed), and the page warns before saving.
- **A refused delivery leaves no trace.** An unlisted owner is answered `200`
  — a policy outcome, not a retryable error — with no `webhook_deliveries` row,
  no PR ledger row, no `last_webhook_at` touch and no enqueued job; the only
  record is one structured warn whose event is `owner_not_allowlisted`.
  Refusals never reach the delivery ledger, so that log line is the only
  evidence a delivery was refused rather than lost.
- **Allowlist reads fail closed.** An unreadable allowlist — a thrown read or a
  row that vanished after the App lookup — refuses the delivery with `500` and
  those same zero writes, so GitHub retries instead of the delivery slipping
  past an unapplied gate (`owner_allowlist_read_failed` /
  `owner_allowlist_row_vanished`). The read runs for every classified delivery
  that carries a repository owner, on and off alike, so an outage now costs
  delayed deliveries where nothing used to be read at all. A payload with no
  readable owner (an install event, a malformed body) cannot be judged and
  proceeds.
- **GitHub App visibility is probed and cached, never enforced.** Whether an
  App is public or private has no authenticated API field, so the dashboard
  probes it anonymously — `GET /apps/{slug}` with no credentials, a 3-second
  budget and no retries: `200` stores `public`, `404` stores `private`, and any
  other answer keeps the stored value, whether the probe ran on the
  metadata-refresh path or was forced by enabling the allowlist. The cached
  `github_visibility` only adds a note under the allowlist control; `404` also
  answers for a missing or renamed slug, so `private` is a UI hint and never
  gates admission. The control renders for every cached value — including a
  private App — because hiding it would leave a live filter unmanageable. An
  App never probed reads `unknown`, which means "cannot prove private".
- **The release version moves to the platform console.** The tenant dashboard
  no longer renders a version footer; the platform console's Runtime screen
  shows `Version vX.Y.Z` from the same build-time constant as `/healthz` and
  the release tags, in every read state of that screen.

<!-- CN -->
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
  （`workspaces.check_min_score`，迁移 `0049`）；接入 App 时用该值作为其分数下限，
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
