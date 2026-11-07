/**
 * Simplified-Chinese dictionary.
 *
 * Typed as `Dictionary` (derived from en.ts via `typeof en`): a missing or
 * extra key is a compile error. Values are plain text; `{placeholder}`
 * tokens match en.ts one-for-one. Technical identifiers (provider ids,
 * slugs, model selectors, brand names) stay untranslated.
 */
import type { Dictionary } from "./en";

export const zhCN: Dictionary = {
  nav: {
    brand: "Morning Star Inspector",
    primary: "主导航",
    apps: "应用",
    members: "成员",
    settings: "设置",
    /** 侧栏底部的平台运营入口（仅 saas 上的 operator 可见）。 */
    platformOperations: "平台运营",
    /** 目标语言的标签 — 切换按钮显示要切换到的语言（中文界面显示 EN）。 */
    language: "EN",
    /** 主题切换：仅图标的按钮；状态与动作在 aria 文案中表达。 */
    /** {mode} = 当前生效主题，{target} = 点击后切换到的主题。 */
    themeToggleAria: "当前显示模式：{mode}，点击切换为{target}",
    themeDark: "深色",
    themeLight: "浅色",
    logout: "退出登录",
    signedInAs: "已登录：{name}",
    workspaceSwitcher: "工作区",
    /** 切换器菜单最后一行——创建工作区入口。 */
    newWorkspace: "新建工作区",
    /** 新建工作区项不可用的原因（`createWorkspaceBlockedReason: "free_slot"`）。 */
    newWorkspaceBlockedFreeSlot:
      "你已属于一个免费工作区 — 每个账号限一个。请删除它，或请其所有者移除你，然后再创建新的工作区。",
    /** 新建工作区项不可用的原因（`createWorkspaceBlockedReason: "flag"`）：平台已关闭工作区创建。 */
    newWorkspaceBlockedFlag: "平台当前已关闭工作区创建。",
  },
  common: {
    pageTitle: "{page} — {brand}",
    time: {
      justNow: "刚刚",
      minuteAgo: "{count} 分钟前",
      minutesAgo: "{count} 分钟前",
      hourAgo: "{count} 小时前",
      hoursAgo: "{count} 小时前",
      dayAgo: "{count} 天前",
      daysAgo: "{count} 天前",
      /** 将来时（formatUntil）— 用量面板的重置时间。 */
      inMinute: "{count} 分钟后",
      inMinutes: "{count} 分钟后",
      inHour: "{count} 小时后",
      inHours: "{count} 小时后",
      inDay: "{count} 天后",
      inDays: "{count} 天后",
      never: "从未",
      unknown: "未知",
    },
    error: {
      removedTitle: "访问已移除",
      removedBody: "你的控制台访问已被移除。请让管理员重新邀请 {login}。",
      forbiddenTitle: "禁止访问",
      forbiddenBody: "此页面仅限控制台管理员访问。你当前以 {login} 登录 — 返回 /dashboard。",
      notFoundTitle: "页面不存在",
      notFoundBody: "此页面不存在，或当前工作空间无权访问。返回 /dashboard。",
      signInErrorTitle: "登录错误",
      signInErrorBody: "登录失败。{message} 未创建会话。请返回 /dashboard/login 重试。",
    },
    oauth: {
      stateInvalid: "无法验证登录（状态无效或已过期）。",
      missingCode: "GitHub 未返回授权码。",
      codeRejected: "GitHub 拒绝了授权码。",
      profileFailed: "无法读取你的 GitHub 资料。",
      /** `signup_open` 关闭：未知账号无法创建账户。 */
      signupClosed: "平台当前已关闭注册。",
    },
    loading: "加载中…",
    loadFailed: "无法加载此页面。",
    saveFailed: "无法保存更改。",
    cancel: "取消",
    retry: "重试",
  },
  login: {
    heading: "登录",
    description: "使用你的 GitHub 账号访问控制台。",
    signIn: "使用 GitHub 登录",
    /** 登录开放 —— 没有访问名单挡在工作区之前。 */
    openAccess: "任意 GitHub 账号均可登录 —— 创建工作区，或接受邀请。",
  },
  notice: {
    success: {
      invited: "已邀请 {login} — 对方现在可以在本工作区接受邀请。",
      removedMember: "已移除 {login}。",
      roleChanged: "{login} 现在是{role}。",
      revoked: "已撤销给 {login} 的邀请。",
      workspaceDeleted: "工作区已删除，其 App 不再接受审查。",
    },
    warn: {
      alreadyMember: "{login} 已是成员 — 未做更改。",
      invitePending: "{login} 已有待接受的邀请 — 未做更改。",
      workspaceUnavailable: "你已无法访问此工作区。",
    },
    error: {
      enterLogin: "请输入要邀请的 GitHub 登录名。",
      invalidLogin: "{login} 不是有效的 GitHub 登录名 — 请使用 1–39 个字母、数字或连字符。",
      inviteFailed: "无法邀请 {login} — 请重试。",
      roleChangeFailed: "无法更改 {login} 的角色 — 成员列表刚刚发生变化，请重试。",
      removeFailed: "无法移除 {login} — 成员列表刚刚发生变化，请重试。",
      revokeFailed: "无法撤销给 {login} 的邀请 — 请重试。",
    },
  },
  /** App 详情页（App detail IA）：标签页外壳。 */
  appDetail: {
    backToApps: "返回应用",
    tabSettings: "应用设置",
    tabInstallations: "已安装",
    tabInsights: "洞察",
    tabPullRequests: "拉取请求",
  },
  /** Per-App 拉取请求标签页：App 收到的所有 PR 台账。详情以 owner/repo/number 寻址（同一 App 可能在多个仓库见到同一个编号），并以 `pr=owner/repo/number` 挂在 URL 上。 */
  pullRequests: {
    backToList: "返回列表",
    /** 台账上方的工具行（仅列表面）。 */
    filterRepo: "仓库",
    filterRepoAll: "全部仓库",
    refreshAria: "刷新拉取请求列表",
    /** 列表表格列——只含行自身的事实。 */
    columnPr: "拉取请求",
    columnState: "状态",
    columnVerdict: "最新结论",
    columnLastSeen: "最近出现",
    columnFailures: "失败",
    /** 组合式空态——无动作变体（PR 由 webhook 产生）。 */
    emptyTitle: "还没有拉取请求",
    emptyDescription: "你的 GitHub App 收到的每个拉取请求都会显示在这里。",
    state: {
      open: "打开",
      closed: "已关闭",
      merged: "已合并",
    },
    /** 详情头部行：`{owner}/{repo} #{number}`。 */
    prNumber: "{owner}/{repo} #{number}",
    /** 头部行的可访问名称：该 PR 的 GitHub 地址。 */
    openOnGithub: "在 GitHub 打开 {owner}/{repo}#{number}",
    /** 侧栏仓库值的可访问名称：该仓库的 GitHub 地址。 */
    openRepoOnGithub: "在 GitHub 打开 {owner}/{repo}",
    /** 审查行提交链接的可访问名称：短 SHA 打开的提交。 */
    openCommitOnGithub: "在 GitHub 打开提交 {sha}",
    /** 短 SHA 徽标的悬浮提示。 */
    headSha: "头部 SHA",
    reviews: "审查",
    noReviews: "此拉取请求还没有审查。",
    reviewMeta: "{model} · {provider}",
    /** 审查行的轮次序号；发现行复用同一文案标明首次报告该发现的轮次。 */
    reviewRound: "第 {round} 轮",
    /** 单轮审查耗时：不足一分钟按秒显示，否则按分秒显示。 */
    reviewDurationSeconds: "{seconds} 秒",
    reviewDurationMinutes: "{minutes} 分 {seconds} 秒",
    /** 耗时 span 的 tooltip（与 head-sha chip 同）：说明这个数值是本轮耗时。 */
    reviewDurationLabel: "本轮运行耗时",
    failures: "失败",
    noFailures: "此拉取请求没有失败记录。",
    findings: "发现",
    noFindings: "此拉取请求没有发现问题。",
    /** 筛选后的发现窗口没有匹配项：文案点名当前严重程度，而不是整个 PR
        （头部计数仍表明该 PR 有发现）。 */
    noFindingsForSeverity: "没有严重程度为“{severity}”的发现。",
    /** 详情头部的元信息行。 */
    firstSeen: "首次出现",
    lastSeen: "最近出现",
    latestReview: "最新审查",
    /** 尚无审查时，结论指标的读屏文本。 */
    noVerdict: "暂无结论",
    /** D11 的“正在审查”标记：存在活的审查锁，携带该次尝试的头部 SHA；
        评论触发没有 SHA 时则携带获取时间。 */
    reviewingHead: "正在审查 · {head}",
    reviewingSince: "正在审查 · {time}",
    /** inflight 读取失败：既不是审查中，也不是确定的空闲。 */
    reviewingUnknown: "审查状态未知",
    reviewingUnknownHint: "无法读取审查状态。",
    /** 三个记录类别上的分段胶囊。 */
    recordsLabel: "拉取请求记录",
    /** 类别触发按钮的可访问名称：标签与它绘制的计数。 */
    familyTabName: "{label}（{count}）",
    /** 发现指标旁的备注，与计数同行渲染。 */
    mustFixNote: "{count} 项必须修复",
    /** 发现筛选的标签与“不筛选”选项。 */
    filterSeverity: "严重程度",
    filterAll: "全部",
    /** 记录列表下方的分页：上一页/下一页与相对总数的已加载区间。 */
    pagePrev: "上一页",
    pageNext: "下一页",
    pageRange: "{from}–{to} / {total}",
    /** 分页区间旁：本页解析被拒绝的行数，它们仍计入总数，任何窗口都取不到。 */
    pageDropped: "{count} 行无法显示",
    /** 严重度分组的计数：分组来自已加载的一页，而标签页的计数是全 PR 总数。 */
    groupPageCount: "本页 {count}",
    /** 严重度分组标题，按渲染顺序。 */
    severityMustFix: "必须修复",
    severityShouldFix: "建议修复",
    severityMayFix: "可修复",
    severityNit: "可忽略",
    severityOther: "其他",
    /** 每条发现正文有一个折叠控件。 */
    expand: "展开",
    collapse: "收起",
    /** 折叠控件的无障碍名称：动作、记录与位置。 */
    foldLabel: "{action} — {record} · #{position}",
    /** 无标识文本的记录只用位置命名。 */
    foldLabelBare: "{action} — #{position}",
    /** 失败块其余输出的折叠（首行已作为诊断显示）与复制动作。 */
    failureRemainingOutput: "其余输出",
    copyError: "复制错误",
    /** 复制动作的瞬时结果，在按钮上显示约两秒。 */
    copyCopied: "已复制",
    copyFailed: "复制失败",
    /** 侧栏：拉取请求事实与合并后的活动时间线。 */
    asideFacts: "拉取请求",
    asideActivity: "活动",
    factRepo: "仓库",
    factNumber: "编号",
    factState: "状态",
    factHead: "提交",
    timelineReview: "审查 · {verdict}",
    /** 载荷未记录结论的审查：整行仍渲染，不留下悬空的分隔符。 */
    timelineReviewNoVerdict: "审查 · 暂无结论",
    timelineFailure: "审查失败 · {stage}",
    /** 载荷未记录阶段的失败：整行仍渲染，不留下悬空的分隔符。 */
    timelineFailureNoStage: "审查失败",
    timelineFirstSeen: "PR 出现",
    /** 上限截断时，末尾说明还有多少条更早的事件未显示（count 为 1 时同样通顺）。 */
    timelineHidden: "更早事件未显示：{count} 条",
  },
  /** Per-App 洞察标签页。7/30/90 窗口分段与仓库筛选语义保持不变。 */
  insights: {
    heading: "审查健康",
    window: "窗口：{label}",
    reviewsTotal: "审查数：{count}",
    verdicts: "结论：{line}",
    noReviews: "此窗口内没有审查。",
    findingsBySeverity: "按严重程度统计的发现",
    trend: "趋势",
    noFindings: "此窗口内没有发现。",
    finding: "{count} 个发现",
    findings: "{count} 个发现",
    review: "{count} 次审查",
    reviews: "{count} 次审查",
    lastDay: "最近 {count} 天",
    lastDays: "最近 {count} 天",
    repo: "仓库 {repo}",
    windowSegment: "时间窗口",
    daysShort: "{count} 天",
    filterRepo: "仓库",
    filterRepoAll: "全部",
    seriesReviews: "审查",
    seriesFindings: "发现",
    trendSummary: "窗口内共 {reviews} · {findings}",
    /** 组合式零审查空态——无动作变体（审查由已安装的 App 产生）。 */
    emptyTitle: "还没有审查",
    emptyDescription: "已安装的 GitHub App 完成审查后，这里会逐渐积累数据。",
  },
  apps: {
    heading: "应用",
    /** 页头带的一行说明（同 en.ts 字段）。 */
    headingDescription: "每个应用是一个 GitHub App；安装范围在应用详情里查看。",
    create: "创建 GitHub App",
    /** 指标带：仅由 `AppsPayload` 可证的四个数字（见 en.ts 同名字段）。 */
    metricApps: "应用",
    metricEnabled: "已启用",
    metricReviewOff: "审查关闭",
    metricRejected24h: "24h 拒收",
    /** Create 控件不可用的原因（见 en.ts 同名字段）。 */
    createUnavailable: {
      role: "只有工作区所有者或管理员可以在此创建 App。",
      workspace: "请先进入某个工作区 — 此部署有多个工作区，App 需要归属其中一个。",
    },
    /** 组合式空态（EmptyState 标题 + 描述）。 */
    emptyTitle: "还没有 App",
    emptyDescription: "使用「创建 GitHub App」连接第一个。",
    detail: "详情",
    appId: "App id {id}",
    by: "创建者 {login}",
    status: {
      active: "活跃",
      disabled: "已停用",
      paused: "已暂停",
    },
    actions: {
      pause: "暂停",
      resume: "恢复",
      disable: "停用（可恢复）",
      enable: "启用",
      delete: "删除",
    },
    health: {
      delivery: "投递 {time}",
      deliveryNever: "从未投递",
      rejected24h: "24 小时内 {count} 次拒绝",
      outcome: {
        ok: "正常",
        paused: "已暂停",
        ignored: "已忽略",
        rejected: "已拒绝",
      },
    },
    tableName: "应用",
    tableStatus: "状态",
    tableHealth: "健康",
    tableCreator: "创建者",
    openAria: "打开 {name} 详情",
  },
  members: {
    heading: "成员",
    visibleToMembers: "本工作区的所有成员都能看到成员名单。",
    workspaceHeading: "本工作区",
    planLabel: "套餐",
    planFreeHint: "仅自带密钥",
    membersLabel: "成员",
    memberSeats: "{count} / {limit}",
    slotsLeft: "还剩 {count} 个名额",
    slotsLeftOne: "只剩 {count} 个名额",
    noSeatsLeft: "名额已满",
    noMemberLimit: "无上限",
    pendingInviteOne: "{count} 个待接受的邀请",
    pendingInvites: "{count} 个待接受的邀请",
    reviewAttemptsLabel: "本月审查次数",
    reviewAttemptsHint: "只计数，不限额。",
    deleteWorkspace: "删除工作区",
    deleteWorkspaceTitle: "删除此工作区？",
    deleteWorkspaceBody:
      "此操作无法撤销。成员将失去访问权限，待接受的邀请将被撤销，本工作区内的 App 将不再接受审查。已开始的审查不会被取消。",
    deleteWorkspaceFailed: "无法删除工作区 — 请重试。",
    deleteWorkspaceNotOwner: "只有工作区所有者才能删除它。",
    inviteLabel: "按 GitHub 登录名邀请",
    invitePlaceholder: "例如 octocat",
    inviteButton: "邀请成员",
    roleLabel: "角色",
    tableLogin: "GitHub 登录名",
    tableJoined: "加入时间",
    tableExpires: "过期时间",
    tableActions: "操作",
    actionsMenuLabel: "打开 {login} 的操作菜单",
    makeAdmin: "改为管理员",
    makeMember: "改为普通成员",
    confirmRoleTitle: "更改 {login} 的角色？",
    confirmRoleBody: "{login} 将成为{role}。更改立即生效。",
    confirmRoleButton: "更改角色",
    confirmRemoveTitle: "移除 {login}？",
    confirmRemoveBody:
      "{login} 将无法再登录 — 其会话立即失效。他们创建的 App 保留，管理员仍可管理。",
    remove: "移除",
    pendingHeading: "待接受的邀请",
    confirmRevokeTitle: "撤销对 {login} 的邀请？",
    confirmRevokeBody: "{login} 将无法接受此邀请。之后可以重新邀请。",
    revoke: "撤销",
    you: "你",
    /** 工作区角色词表（`workspace_members.role`），含 owner。 */
    role: {
      owner: "所有者",
      admin: "管理员",
      member: "成员",
    },
    /** 组合式空态——无动作变体（上方邀请表单即路径）。 */
    emptyTitle: "还没有成员",
    emptyDescription: "使用上方表单邀请第一位成员。",
    emptyDescriptionMember: "本工作区目前没有其他成员。",
  },
  /**
   * 工作区创建 —— 尚未加入任何工作区的登录用户的落地页：
   * 登录不会自动加入工作区，除了接受邀请，这里是进入首个工作区的唯一路径。
   */
  workspace: {
    settingsHeading: "工作区设置",
    setupHeading: "创建工作区",
    setupDescription: "你还不属于任何工作区。创建后你将成为它的所有者，之后可以邀请队友。",
    /** 切换器菜单里的创建弹窗：已有工作区的成员也可用，因此不复述「还没有工作区」。 */
    createDialogDescription: "为它命名，你将成为其所有者——之后可以邀请队友。",
    /** `self-hosted` 空实例提示：本次登录创建了部署的第一个账号。 */
    emptyInstance: "本实例还没有任何账号。你的登录现在已是本实例的第一个账号——创建一个工作区即可开始。",
    nameLabel: "工作区名称",
    namePlaceholder: "例如 Acme",
    create: "创建工作区",
    nameRequired: "请输入工作区名称。",
    nameTooLong: "最多 {max} 个字符。",
    createFailed: "创建工作区失败，请重试。",
    /** 创建界面上的待处理邀请——受邀者的接受入口（MF-2）。 */
    invitesHeading: "你收到了邀请",
    invitesDescription: "接受邀请即可加入对应工作区，也可以在下方创建自己的工作区。",
    inviteAccept: "接受",
    /** {role} = 受邀的工作区角色；{expires} = 相对的到期时间。 */
    inviteMeta: "以 {role} 身份被邀请——{expires} 到期",
    inviteExpired: "该邀请已过期。",
    inviteGone: "该邀请已失效——可能已被撤回。",
    inviteAcceptFailed: "接受邀请失败，请重试。",
    /** `/dashboard/<ref>/settings` 的管理者门禁——普通成员看到此文案。 */
    settingsOwnerOnly: "只有工作区所有者和管理员可以修改这些设置。",
    /** 所有者的名称卡片——顶部切换器显示的名称。 */
    nameHeading: "工作区名称",
    nameDescription: "顶部工作区切换器显示的名称。此工作区的网址是其 id，不会改变。",
    nameSave: "保存名称",
    nameSaved: "工作区名称已更新。",
    nameFailed: "修改工作区名称失败，请重试。",
    /** 所有者/管理员可见的“新 App 默认审查门禁”卡片。 */
    checkMinScoreHeading: "审查门禁默认值",
    checkMinScoreDescription:
      "新接入 App 的分数下限起始值。已有 App 保留各自的分数下限，请在该 App 的设置页修改。",
    checkMinScoreLabel: "默认分数下限",
    checkMinScoreSave: "保存默认值",
    checkMinScoreSaved: "审查门禁默认值已更新。",
    checkMinScoreFailed: "无法修改审查门禁默认值——请重试。",
    /** {min}/{max} = 可接受的范围。 */
    checkMinScoreRange: "接受 {min}–{max}。",
    /** {min}/{max} = 可接受的范围；显示的数字是兜底值。 */
    checkMinScoreUnreadable:
      "无法读取已存储的默认值，因此新 App 将使用平台默认值。保存 {min}–{max} 之间的值会设置本工作区的默认值，重新读取可刷新；若刷新后仍提示，请联系平台运维。",
    concurrencyHeading: "审查并发",
    concurrencyDescription: "此工作区最多同时运行的审查数量。平台可能进一步限制。",
    concurrencyLabel: "并发审查数",
    concurrencySave: "保存并发数",
    concurrencySaved: "审查并发数已更新。",
    concurrencyFailed: "修改审查并发数失败，请重试。",
    /** {min}/{max} = 此工作区自己的范围。 */
    concurrencyRange: "可设置 {min}–{max}。",
    /** {min}/{max} = 此工作区自身范围；显示的数字只是兜底值。 */
    concurrencyUnreadable:
      "无法读取已存储的审查并发数，因此审查可能仍逐个运行。显示的数字只是兜底值。保存 {min}–{max} 之间的值会设置本工作区的值，重新读取可刷新；若刷新后仍提示，请联系平台运维。",
  },
  /**
   * 平台运维支持（2026-10）：运维人员的只读界面与租户不可关闭的授权通知。
   * 通知说明谁在查看、原因与到期时间——不提供任何操作，因为租户既不能结束
   * 也不能修改一份授权。
   */
  support: {
    heading: "支持访问",
    readOnly: "你正在限时支持授权下查看此工作区。此处全部内容为只读。",
    workspaceId: "工作区 id",
    createdAt: "创建时间",
    grantsHeading: "生效中的支持授权",
    grantLine: "{login} 拥有支持访问权限，到期时间 {expires} —— {reason}",
    tableLogin: "GitHub 登录名",
    tableRole: "角色",
    /** 租户口径的常驻通知；不可关闭，不带任何操作。 */
    noticeHeading: "支持访问已生效",
    noticeLine: "{login} 可查看此工作区的成员，直至 {expires} —— {reason}",
    noticeError: "无法检查支持访问状态。",
    noGrant: "当前没有生效的支持访问。",
  },
  settings: {
    changesSaved: "更改已保存。",
    removeNoChange: "未做任何更改 — 没有可移除的内容。",
    addKey: "添加密钥",
    provider: "模型提供方",
    apiKey: "API 密钥",
    apiKeyPlaceholder: "粘贴 provider API 密钥",
    keyEnding: "密钥结尾 {last4}",
    keyTooShort: "密钥太短，无法显示结尾",
    updated: "更新于 {time}",
    remove: "移除",
    selectProvider: "搜索模型提供方…",
    noProviderMatch: "没有匹配「{query}」的模型提供方。",
    modelChainField: "模型链",
    saveChain: "保存模型链",
    providerId: "Provider id",
    baseUrl: "Base URL",
    api: "API",
    modelIds: "模型 id",
    addCustomProvider: "添加自定义 provider",
    selectApi: "选择 API…",
    roleHintReviewSeat: "快速 + 默认审查席位",
    roleHintDeep: "深度审查席位",
    saveRoleModels: "保存席位链",
    pauseReviews: "暂停审查",
    resumeReviews: "恢复审查",
    disconnected: "此 App 已断开连接 — 启用后即可审查。",
    lastWebhook: "最近 webhook：{time}",
    installations: "安装",
    installationsCount: "{count} 个安装",
    installationsCountOne: "{count} 个安装",
    installationsAccount: "账号",
    installationsAvailability: "可用性",
    availabilityValid: "有效",
    availabilityInvalid: "无效",
    installationsId: "安装 ID",
    installationsLastSync: "最近同步",
    /** App 详情页指标带中 provider 密钥数的标签。 */
    metricKeys: "密钥",
    noInstallations: "还没有安装。",
    recentDeliveries: "最近投递",
    recentDeliveriesCopy: "最多 10 次 webhook 投递 — 带结论的（正常 / 已暂停 / 已拒绝）排在前，其余按时间从新到旧。",
    noDeliveries: "还没有投递。",
    unknownEvent: "未知事件",
    unknownSource: "未知仓库",
    status: "状态 {code}",
    addToChain: "加入模型链",
    noAutoDiscovery: "此 provider 不列出模型 — 请从其他已验证 provider 中选择。",
    noVerifiedModels: "验证 provider 密钥后即可填充模型选项。",
    chainEmpty: "模型链中还没有模型。",
    pickModel: "选择模型…",
    keyVerified: "密钥已验证 — 模型已缓存。",
    verify: {
      invalid_key: "该 API 密钥被 provider 拒绝 — 未存储任何内容。",
      unreachable: "无法连接 provider — 未存储任何内容。",
      unexpected: "provider 返回了意外响应 — 未存储任何内容。",
      unsupported_provider: "此 provider 无法在此验证 — 请在对应控制台管理密钥。未存储任何内容。",
    },
    membership: {
      not_in_verified_models: "选择器 {selector} 不在此 App 的已验证模型中。",
    },
    // 设置 POST 400 的机器可读文案（与 en.ts settings.error 一一对应）。
    error: {
      providerRequired: "请为密钥选择一个 provider。",
      providerUnknown: "{provider} 不是受支持的 provider — 请从列表中选择。",
      providerUnavailableOnHarness: "{provider} 在此 App 选定的运行时 harness（{image}）上不可用 — 未存储任何内容。",
      apiKeyRequired: "请输入要存储的 API 密钥。",
      apiKeyTooLong: "该 API 密钥过长（{count} 个字符）— 密钥上限为 {limit} 个字符。未存储任何内容。",
      apiKeyCommandPrefix:
        "该 API 密钥以 “!” 开头 — 审查运行时会把它当作 shell 命令执行，因此这类密钥会被拒绝。未存储任何内容。",
      providerKeyLimit:
        "{provider} 已存满 {limit} 把密钥 — 请先移除一把再添加。未存储任何内容。",
      chainFieldDuplicated: "模型链字段被提交了多次 — 请重新提交表单。未保存任何内容。",
      chainTooLong: "该模型链过长（{count} 个字符）— 上限为 {limit} 个字符。未保存任何内容。",
      chainEmpty: "请至少输入一个以逗号分隔的模型选择器。",
      roleFieldDuplicated: "{field} 字段被提交了多次 — 请以每个席位一个值重新提交「席位链」表单。未保存任何内容。",
      roleUnknown: "{role} 不是已知的审查席位 — 未保存任何内容。",
      roleFieldsMissingAll: "没有提交任何席位链引用 — 请重新提交「席位链」表单。",
      roleFieldMissing: "{roles} 席位字段缺失 — 「席位链」表单总是保存每个席位（留空 = 默认链）。未保存任何内容。",
      roleFieldsMissing: "{roles} 席位字段缺失 — 「席位链」表单总是保存每个席位（留空 = 默认链）。未保存任何内容。",
      roleChainUnknown: "{role} 不是已知的模型链 — 请从列表中选择，或留空以使用默认链。未保存任何内容。",
      chainNameInvalid: "链名称必须为 1–{limit} 个小写字母、数字或连字符 — 且「default」为保留名。未保存任何内容。",
      chainValueRequired: "请为该命名链输入模型链。",
      defaultChainRemoveProtected: "「default」链无法移除 — 请改为清空。未保存任何内容。",
      providerIdRequired: "请为自定义 provider 输入 provider id。",
      providerIdInvalid: "provider id 只能包含小写字母、数字和连字符 — 1 到 64 个字符，以字母或数字开头。未存储任何内容。",
      providerIdBuiltin: "{provider} 是内置 provider — 自定义 provider 必须使用新的 id。未存储任何内容。",
      providerIdBaseConfig: "{provider} 已由审查环境的基础配置提供 — 自定义 provider 必须使用新的 id。未存储任何内容。",
      customProviderMax: "此 App 已达到 {limit} 个自定义 provider 的上限 — 请先移除一个再声明新的（更新现有声明不受限制）。未存储任何内容。",
      baseUrlRequired: "请输入该 provider 的 Base URL。",
      baseUrlInvalid: "Base URL 必须是带主机的有效 https URL — 未存储任何内容。",
      baseUrlTooLong: "该 Base URL 过长（{count} 个字符）— 上限为 {limit} 个字符。未存储任何内容。",
      apiProtocolRequired: "请为自定义 provider 选择 API 协议。",
      apiProtocolUnknown: "{api} 不是受支持的 API 协议 — 请从列表中选择。未存储任何内容。",
      modelIdsRequired: "请为自定义 provider 至少输入一个模型 id。",
      modelIdsTooMany: "模型 id 过多（{count} 个）— 最多 {limit} 个。未存储任何内容。",
      modelIdTooLong: "每个模型 id 最多 {limit} 个字符。未存储任何内容。",
      customProviderDeclRejected: "该自定义 provider 被拒绝 — 未存储任何内容。",
      customProviderUndeclared: "{provider} 不是此 App 已声明的自定义 provider — 请先声明再添加密钥。未存储任何内容。",
      providerEndpointLocked:
        "{provider} 已为其当前端点存储了密钥 — 请先移除这些密钥再更改其 Base URL 或 API 协议。未存储任何内容。",
      templateUnknown: "未知的 provider 模板 — 未存储任何内容。",
      templateIncomplete: "该 provider 模板不完整 — 未存储任何内容。",
      accountIdRequired: "请输入你的 Cloudflare 账户 id 以补全 Workers AI Base URL。",
      accountIdInvalid: "Cloudflare 账户 id 为 32 位十六进制字符 — 未存储任何内容。",
      templateIdBuiltin: "{template} 是内置 provider — 未存储任何内容。",
      templateIdBaseConfig: "{template} 已由审查环境的基础配置提供 — 未存储任何内容。",
      materializedBaseUrlInvalid: "物化后的 Base URL 不是有效的 https URL — 未存储任何内容。",
      templateApiUnsupported: "{api} 不是受支持的 API 协议 — 未存储任何内容。",
      templateNoModels: "该 provider 模板没有任何模型 id — 未存储任何内容。",
      templateMaterializeMax: "此 App 已达到 {limit} 个自定义 provider 的上限 — 请先移除一个再物化新模板（更新现有声明不受限制）。未存储任何内容。",
      runtimeHarnessUnknown: "未知或已停用的运行时 harness — 未存储任何内容。",
      triggerModeUnknown: "{mode} 不是有效的审查触发模式 — 可用值为 open、every_push、manual。未存储任何内容。",
      reviewLevelUnknown:
        "{level} 不是有效的评审深度 — 可用值为 quick、default、deep（或 inherit 表示跟随平台默认）。未存储任何内容。",
      checkScoreInvalid: "审查门禁分数必须是 {min} 到 {max} 之间的整数。未存储任何内容。",
      checkVerdictUnknown: "{verdict} 不是有效的审查结论 — 可用值为：{verdicts}。未存储任何内容。",
      allowlistToggleInvalid: "所有者白名单开关必须为开或关。未存储任何内容。",
      allowlistTooManyOwners: "所有者白名单最多接受 {limit} 个所有者 — 未存储任何内容。请移除部分登录名后重新提交。",
      allowlistInvalidOwner:
        "{owner} 不是有效的 GitHub 登录名 — 请使用 1–39 个字母、数字或连字符。未存储任何内容。",
      fieldDuplicated: "{field} 字段被提交了多次 — 请以单个值重新提交表单。未保存任何内容。",
      unknownOperation: "未知的设置操作 — 请重新提交此页面的某个表单。",
      githubMetadataRefreshFailed: "GitHub 未返回该 App 的元数据 — 未刷新任何内容。请确认该 App 仍然存在后重试。",
      concurrencyInvalid: "并发数必须是 {min} 到 {max} 之间的整数。未存储任何内容。",
    },
    ops: "运维",
    opsCopy: "以下操作改变此 App 如何应答传入的投递。",
    opsReviewsTitle: "审查投递",
    opsReviewsCopy: "暂停期间，每次投递都以 2xx 应答并被忽略 — 不会进行任何审查；恢复后此 App 重新开始审查。",
    opsDeliveryTitle: "投递应答",
    opsDeliveryCopy: "停用后，每次投递都以 404 应答，因此不会进行任何审查；重新启用后此 App 重新开始审查。",
    opsDeleteTitle: "删除此 App",
    opsDeleteCopy: "软删除 — App 从此列表移除，其所有安装都会被关闭。",
    // 评审触发模式（spec review-trigger-policy §2/§3）：分段标签本地化；
    // 线上取值（open / every_push / manual）与提及字符串保持原样。
    triggerMode: "审查触发",
    triggerModeOpen: "首次打开",
    triggerModeEveryPush: "每次推送",
    triggerModeManual: "仅手动",

    triggerModeMention: "PR 作者或仓库所有者：在 PR 评论中 @ 它即可（重新）启动审查：",
    triggerModeMentionAria: "机器人提及：{mention}",
    // 评审深度（migration 0047）：App 深度选择器的四个面孔。线上取值保持
    // quick/default/deep（另有 inherit 面孔自有哨兵值），仅标签本地化。
    reviewDepth: "评审深度",
    reviewDepthCopy: "控制此 App 每次评审的深入程度。快速成本最低，深入最彻底。",
    reviewDepthQuick: "快速",
    reviewDepthQuickHint: "单轮快速评审",
    reviewDepthStandard: "标准",
    reviewDepthStandardHint: "均衡深度（推荐）",
    reviewDepthDeep: "深入",
    reviewDepthDeepHint: "最彻底，耗时更长",
    reviewDepthInherit: "跟随平台默认（当前：{level}）",
    confirmPauseTitle: "暂停 {slug} 的审查？",
    confirmPauseBody: "Webhook 保持连接 — 投递会被应答并忽略，直到你恢复。",
    confirmResumeTitle: "恢复 {slug} 的审查？",
    confirmResumeBody: "此 App 将再次审查拉取请求。",
    confirmDisableTitle: "停用 {slug}？",
    confirmDisableBody: "GitHub 投递将得到 404，直到你再次启用。",
    confirmDisableAction: "停用",
    confirmEnableTitle: "启用 {slug}？",
    confirmEnableBody: "此 App 将再次接受 webhook 投递。",
    confirmDeleteTitle: "删除 {slug}？",
    confirmDeleteBody: "这是软删除。App 从列表消失；审查失败关闭。",
    confirmDeleteButton: "删除应用",
    deleteSuccess: "App 已删除，已从应用列表中移除。",
    providers: {
      title: "模型提供方",
      status: {
        ok: "已验证",
        reachable: "端点可达",
        failed: "验证失败",
        unverified: "未验证",
      },
      tier: { builtin: "内置", template: "模板", custom: "自定义" },
      summary: "{total} 个密钥 · {ok} 已验证 · {reachable} 端点可达 · {failed} 验证失败 · {unverified} 未验证",
      /** 中文无单复数；与 summary 同形（type parity 要求两个键都在）。 */
      summaryOne: "{total} 个密钥 · {ok} 已验证 · {reachable} 端点可达 · {failed} 验证失败 · {unverified} 未验证",
      verifiedAt: "{time} 验证通过",
      modelCount: "{count} 个模型",
      modelCountOne: "{count} 个模型",
      models: {
        trigger: "编辑模型",
        title: "{label} 的模型",
        searchLabel: "筛选模型 id",
        searchPlaceholder: "筛选模型 id…",
        selectAll: "全选",
        selectNone: "全不选",
        counter: "已选 {selected} / {max} — 每个提供方最多 {max} 个模型 id。",
        capReached: "已达 {max} 个模型上限 — 请先取消勾选再添加。",
        noMatch: "没有匹配「{query}」的模型。",
        save: "保存模型",
      },
      stepPick: "选择",
      stepConfigure: "配置",
      back: "返回",
      verifying: "验证中…",
      saving: "保存中…",
      addKeyTo: "为 {label} 添加密钥",
      keyUsage: "已存 {count} / {limit} 个密钥。",
      keyLimitReached: "该提供方已存满 {limit} 个密钥 — 请先删除一个再添加。",
      expand: "展开",
      collapse: "收起",
      empty: "还没有密钥 — 添加第一个密钥后即可在模型链中使用。",
      // 仅控制台分支：内置 id 已被存储层保留，用户自填的端点只能落在自
      // 己的 id 上；文案不得声称控制台是唯一途径。
      customEndpoint: "配置自定义端点",
      customEndpointCopy:
        "{provider} 的内置 id 已被保留 — 自定义端点需要使用自己的 id。点此打开声明表单，已填入该提供方的 API 协议与 Base URL 形态。",
      customIdRequired: "{provider} 已被占用 — 请为此声明填写新的 id。",
      submitFailed: "该请求未到达服务端即失败 — 未存储任何内容。",
      /**
       * 每密钥用量探测：密钥行的操作按钮、其在该行下方展开的面板，以及四种形态
       * — ok（窗口条 / 余额）、unauthorized、absent、error。线上的诊断
       * reason 从不原样渲染。
       */
      usage: {
        action: "用量",
        error: "暂时无法读取该密钥的用量。",
        unauthorized: "提供方拒绝了该密钥 — 可能已撤销或过期。",
        absentNoProbe: "该提供方没有用量探测。",
        absentNothing: "提供方未报告该密钥的用量窗口。",
        windowRemaining: "剩余 {percent}%",
        resets: "{time} 重置",
        balanceRemaining: "剩余 {amount} {unit}",
        /** On-demand credits shown beside the pool in the same cell: bought once, never reset. */
        extraRemaining: "另有 {amount} {unit} 加购",
        /** 多个密钥共享同一个账户级额度池，而非每密钥独立额度。 */
        shared: "账户级共享",
        /** 每行标签：取自规范化 limit id 最后一个 ":" 后的语义段。 */
        window: {
          session: "会话",
          week: "每周",
          month: "每月",
          concurrency: "并发",
          balance: "余额",
        },
        /**
         * 未知语义段的兜底标签 — id 段从不直接渲染（可能是提供方的桶名），
         * 未知行改用带序号的通用标签。
         */
        limit: {
          generic: "额度 {index}",
          genericSingle: "额度",
        },
        unit: { requests: "次请求", credits: "点数", usd: "美元", tokens: "个令牌", percent: "%" },
      },
    },
    providersCopy:
      "此 App 已配置的模型提供方 — 存储的密钥仅显示掩码尾号，自定义声明显示其 Base URL 与模型。添加模型提供方从目录选择开始；密钥仅在验证成功后存储。",
    noConfiguredProviders: "尚未配置任何模型提供方 — 请使用「添加模型提供方」进行配置。在验证提供方密钥之前，审查将失败关闭。",
    addProvider: "添加模型提供方",
    addProviderCopy: "从目录中选择一个模型提供方 — 选中后显示其配置要求。在 App 运行时 harness 上不可用的条目会被标记且无法保存；目录外的提供方请使用下方的自定义声明。",
    catalogProvenance:
      "{count} 个提供方，来自已提交的 models.dev 与 omp 快照并编译进应用 — 在提交密钥验证之前不会联系任何提供方。",
    catalogBuiltin: "常用提供方",
    catalogTemplate: "目录模板",
    eligibilityBuiltin: "可与 {image} 运行时 harness 配合使用 — 该提供方作为内置提供方运行。",
    eligibilityTemplate: "物化后可与 {image} 运行时 harness 配合使用 — 账户 id 与密钥将保存为自定义提供方声明。",
    eligibilityUnavailable:
      "无法在 {image} 运行时 harness 上使用 — 该条目仅为目录展示，无法为此 App 配置。可切换 App 的运行时 harness，或改用自定义声明。",
    eligibilityUnavailableShort: "{image} 上不可用",
    configureProvider: "配置 {label}",
    customEntry: "自定义",
    customEntryCopy: "声明非内置 provider — id、Base URL、模型 id 与密钥。",
    accountId: "账户 id",
    accountIdPlaceholder: "32 位十六进制",
    addTemplate: "添加 {label}",
    modelChains: "模型链",
    modelChainsCopy:
      "Default 链与命名链是同级标签页 — 在各自的标签页中编辑链。Default 链是必需的且无法移除；移除命名链后，引用它的席位将回退到 Default 链。",
    addChain: "新建链",
    chainName: "链名称",
    chainNamePlaceholder: "例如 deep-review",
    draftChain: "新链",
    discardChain: "放弃",
    defaultChain: "Default 链",
    seats: "席位链",
    seatsCopy: "每个审查席位运行在 Default 链或显式选择的命名链上 — 其命名链被移除的席位会回退到 Default。",
    useDefaultChain: "Default 链",
    confirmRemoveChainTitle: "移除链 {name}？",
    confirmRemoveChainBody: "引用 {name} 的席位将回退到 Default 链。",
    consoleOnly: "此 provider 无法在此验证 — 其端点没有固定主机，因此这条内置条目不接受密钥。",
    confirmRemoveKeyTitle: "移除 {provider} 末尾为 {last4} 的密钥？",
    confirmRemoveKeyBody: "该 App 的其他 {provider} 密钥不受影响。仅依赖此密钥的选择器在你重新验证前会失败。",
    confirmRemoveCustomTitle: "移除 provider {provider}？",
    confirmRemoveCustomBody:
      "该 provider 及其密钥池中的全部密钥都将被移除。若只想腾出一个槽位，请移除该密钥所在的行。引用其模型的链在保存时会校验失败。",
    runtimeHarness: "运行时 harness",
    runtimeHarnessCopy:
      "执行此 App 审查的沙盒镜像中挂载的 {id} 运行时 harness。审查在运行时读取模型配置 — 任何 App 特定配置都不会烘焙进镜像。",
    runtimeHarnessValue: "此 App 的审查运行在 {id} 运行时 harness 上。",
    saveRuntimeHarness: "保存运行时 harness",
    // GitHub 身份卡。{name}/{id}/{time} 为同步的资料名、数字 App id
    // 与相对同步时间（formatRelativeTime 输出）— 服务端字段可空、逐项降级，
    // 每个键仅在其值存在时渲染。
    appInfo: "GitHub App",
    appInfoCopy: "此 App 在 GitHub 上的身份。资料字段在访问设置页时从该 App 的 GitHub 设置页缓存；点击名称可前往 GitHub 管理。",
    appInfoAppId: "App ID：{id}",
    // 本地行 id——webhook URL 的第二段，与 GitHub App id 并列显示，
    // 使 URL 的两段都可直接从卡片读出。
    appInfoLocalId: "本地 App ID：{id}",
    // 仅管理面：webhook 重指向所需的绝对投递 URL。部署文档让运维来此卡查看。
    appInfoDeliveryUrl: "Webhook URL：",
    appInfoViewOnGithub: "在 GitHub 上查看 {name}",
    // (AD-623) 管理面标签——名称链接指向该 App 的 GitHub 设置页，
    // 可及名用「管理」而非「查看」。成员面沿用 appInfoViewOnGithub。
    appInfoManageOnGithub: "在 GitHub 上管理 {name}",
    appInfoSynced: "同步于 {time}",
    // (D5) 仅管理面的强制刷新：绕过 24h TTL 重新拉取缓存的 GitHub 资料；
    // 成功提示确认缓存已重载。
    appInfoRefresh: "从 GitHub 刷新",
    appInfoRefreshDone: "已从 GitHub 刷新身份。",
    // 已安装标签页：可分享的 GitHub 安装入口。
    install: "安装",
    installCopy: "把此链接交给任意 GitHub 账号，即可在该账号上安装此 App。",
    installLink: "打开安装页面",
    installLinkAria: "在新标签页中于 GitHub 安装 {name}",
    installNoSlug: "此 App 尚无 GitHub slug，因此没有安装链接。请先刷新 GitHub 身份，再分享链接。",
    // 已安装标签页：仓库所有者允许名单（迁移 0045）。
    allowlist: "所有者允许名单",
    allowlistCopy: "开关打开时，仅审查这些仓库所有者发起的交付。",
    allowlistEnable: "仅审查允许名单中的所有者",
    allowlistOwners: "允许的所有者（每行一个 GitHub 登录名）",
    allowlistFailClosed: "开关已打开但名单为空：所有交付都会被拒绝，不会有任何审查运行。",
    allowlistPrivateStillApplies:
      "此 App 为私有，但已存储的名单仍会作用于其交付 — 控件保持显示，以便你管理名单。",
    allowlistSave: "保存允许名单",
    // 设置标签页：Check 所报告的审查门禁（迁移 0045）。
    reviewGate: "审查门禁",
    reviewGateCopy: "仅当结论属于以下之一且分数达到下限时，Check 才通过。",
    reviewGateScore: "最低分数（0–100）",
    reviewGateVerdicts: "可通过的结论",
    reviewGateFailClosed: "未选中任何结论：任何审查都无法通过 — 在你选中之前，每个 Check 都会失败。",
    reviewGateSave: "保存审查门禁",
    reviewGateUnreadable:
      "无法读取此 App 已存储的审查门禁，因此无法在此编辑。在存储的配置被修复之前，Check 会持续按失败处理。",
    reviewGateReset: "重置为默认门禁（分数 {score}+，结论：{verdicts}）",
  },
  manifest: {
    title: "创建 GitHub App",
    start: {
      heading: "创建 GitHub App",
      body:
        "继续前往 GitHub，为 {appName} 注册审查权限和此 Worker 的 webhook。GitHub 会先显示所请求的权限 — 在你确认之前不会创建任何内容。",
      continue: "在 GitHub 上继续",
      cancel: "取消",
    },
    confirm: {
      heading: "创建 GitHub App",
      ready: "GitHub App {appName}（id {id}）已准备好连接。",
      registeredAs: "它将为此部署注册为：",
      slugWebhook: "Slug {slug} · webhook URL {webhookUrl}",
      // 首次元数据同步前 GitHub 的 slug 未知；数字 App id 是诚实的替代值，并如实标注。
      appIdWebhook: "App ID {id} · webhook URL {webhookUrl}",
      note: "连接后，此 App 的 pull_request 和 issue_comment webhook 将投递到此 Worker。审查按 App 控制 — 暂停某个 App 即可停止其审查。",
      create: "创建 App",
      cancel: "取消",
    },
    onboarding: {
      title: "GitHub App 已连接",
      heading: "GitHub App 已连接",
      connected: "GitHub App {appName}（id {id}）已连接到此部署。",
      slug: "Slug：{slug}",
      // slug 为 NULL 时页面展示的是数字 App id，标签如实说明。
      appId: "App ID：{id}",
      webhookUrl: "Webhook URL：{webhookUrl}",
      nextStep: "下一步：打开设置并配置 provider — 验证 provider key 并选择模型后，此 App 的审查才会开始。",
      openSettings: "打开设置",
      dashboard: "返回 /dashboard",
    },
    error: {
      title: "GitHub App 设置",
      failedHeading: "GitHub App 设置失败。",
      secretsUnchanged: "未更改任何 Worker 密钥。",
      resumable: "你的 GitHub App 仍保留用于重试 — 返回确认页面重新提交。",
      confirmPage: "确认页面",
      retry: "返回 /dashboard 重试。",
      stateMismatch: "无法验证创建流程（state 无效或已过期）。",
      missingCode: "GitHub 未返回 app-manifest code。",
      codeRejected: "GitHub 拒绝了该 app-manifest code。",
      loginMismatch: "此确认属于另一个 GitHub 登录 — 请重新登录并从头开始创建流程。",
      noEncryptionKey:
        "此部署没有有效的 DASHBOARD_ENCRYPTION_KEY 来存储 App 凭据 — 请让运维配置后再提交。",
      alreadyConnected: "此 GitHub App 已在此部署上连接 — 未做任何更改。",
      dbRejected: "无法存储该 App — 控制台数据库拒绝了写入。你可以重新提交。",
      dbUnbound: "控制台存储未配置 — 无法存储该 App。",
      workspaceFloorUnreadable:
        "无法连接该 App — 无法读取此工作区的默认评分下限，因此没有存储任何内容。修复该设置后再重新提交即可。",
      workspaceFloorReadFailed:
        "无法连接该 App — 暂时无法读取此工作区的默认评分下限，因此没有存储任何内容。重新提交即可重试。",
      floorRepair: "前往",
      floorRepairLink: "工作区设置",
      floorRepairEnd: "。",
      workspaceRequired:
        "此部署有多个工作区，App 需要归属其中一个 — 请先进入某个工作区，再从那里创建 App。",
      workspaceGone:
        "创建此 App 的工作区已不存在，因此此 App 在此部署中没有可访问的工作区页面 — 请在 GitHub 上删除它，然后从仍存在的工作区重新开始创建流程。",
    },
  },
  /**
   * 平台控制台（`/_internal_admin`）—— 运维界面。与工作区外壳共用同一个
   * locale cookie 实现双语：`main.tsx` 读取 `boot.locale`，每个页面组件接收
   * locale prop，页面文案通过 `t(locale, …)` 解析。这些键面向运维，绝不复用
   * 面向租户的 `support.*` 文案。
   */
  admin: {
    /** 文档 `<title>` —— 由 `serveDocument` 在服务端替换。 */
    documentTitle: "Morning Star — 平台运营",
    header: {
      title: "平台运营",
      /** boot 未携带登录名时显示在标题下方。 */
      signedOut: "已退出登录",
      /** 返回运维自己的工作区外壳。 */
      dashboardLink: "工作区控制台",
    },
    /** 控制台导航标签 —— `pages.ts` 通过 `labelKey` 路由。 */
    nav: {
      flags: "服务器开关",
      runtime: "运行时参数",
      workspaces: "工作区",
      users: "用户",
      supportGrants: "支持访问",
    },
    /**
     * 控制台写入被服务器拒绝：页面的通用失败文案为主，服务器自身的
     * `{error}` 文本作为次要细节附带展示（PageNotice 的单条 message
     * 字符串同时承载两者）。
     */
    refusalDetail: "服务器返回：{detail}",
    /** 服务器开关页。 */
    flags: {
      description: "平台级开关。更改对下一个请求生效，并追加一条审计记录。",
      loadFailed: "无法加载服务器开关。",
      emptyTitle: "没有开关",
      emptyDescription: "此服务器没有暴露任何平台开关。",
      flagColumn: "开关",
      effectColumn: "关闭时的影响",
      stateColumn: "状态",
      /** 两个语言环境都渲染为 ON/OFF（compass D9）。 */
      stateOn: "ON",
      stateOff: "OFF",
      /** review_global 键下方的说明（spec §3.1）。 */
      reviewGlobalNote: "已排队的任务不会被取消。",
      noDocumentedEffect: "没有记录在案的影响。",
      /** 每个开关关闭时影响什么，按开关键索引。 */
      effectReviewGlobal: "不再排队新的审查。每个 App 的暂停开关不受影响。",
      effectSignupOpen: "未知的 GitHub 登录无法首次登录，已有账号不受影响。",
      effectWorkspaceCreationOpen: "任何工作区都无法创建，运维自己的也不例外。",
      /** 写入确认对话框 — {flag}、{from}、{to}（ON/OFF）为插值。 */
      confirmTitle: "将 {flag} 从 {from} 切换为 {to}？",
      confirmButton: "确认",
      cancelButton: "取消",
      /** 写入成功后行内显示的简短确认。 */
      saved: "已保存。",
      /** 写入失败且错误无法识别时的兜底文案。 */
      toggleFailed: "无法更改 {flag}。",
      /** 开关的可访问名称：“{flag} {state}”，state 为 ON/OFF。 */
      stateAria: "{flag} {state}",
    },
    /** 运行时参数页（迭代规格 §1.1）。 */
    runtime: {
      description: "非机密的运行时参数。更改会在下一次审查生效，并追加一条审计记录。",
      loadFailed: "无法加载运行时参数。",
      concurrencyTitle: "系统审查并发",
      concurrencyDescription: "整个平台同时运行的审查数量。Cloudflare Queues 最多同时投递 250 个，因此高于该值的配额有效但平台无法跑满。",
      concurrencyLabel: "并发审查数",
      concurrencySave: "保存",
      concurrencySaved: "已保存。",
      /** 写入失败且错误不可识别时的兜底文案。 */
      concurrencyFailed: "修改系统并发数失败。",
      /** {value} = 当前存储的上限（或文档默认值）。 */
      concurrencyCurrent: "下一次审查生效值：{value}。",
      /** 已存储的上限无法读取——数字只是兜底值，不是已存储的设置。 */
      concurrencyUnreadable:
        "无法读取已存储的系统并发数，因此每个工作区都在逐个运行审查。输入范围内的值可保存为新的并发数，重新读取会重新检查该行。",
      checkTitle: "检查预算",
      checkDescription:
        "审查等待其 GitHub Check 的时长：terminalize hook 与唯一一次终态 update。审查不会被这两个上限阻塞。",
      terminalizeLabel: "terminalize hook（毫秒）",
      updateLabel: "Check update（毫秒）",
      checkSave: "保存",
      checkSaved: "已保存。",
      /** 写入失败且错误无法识别时的兜底文案。 */
      checkFailed: "修改检查预算失败。",
      /** {terminalize}/{update} = 当前存储的预算（或文档默认值）。 */
      checkCurrent: "下一次审查生效值：terminalize {terminalize} 毫秒，update {update} 毫秒。",
      /** 两个已存储的预算都无法读取——数字只是文档默认值。 */
      checkUnreadable:
        "无法读取已存储的检查预算，因此正在使用文档默认值。输入范围内的值可保存为新值，重新读取会重新检查这些行。",
      claimTitle: "评论触发恢复",
      claimDescription:
        "cron 如何恢复「已声明但队列发送从未发生」的机器人提及评论：声明后等待多久才重发、允许多少次尝试，以及一次扫描最多重发多少条。",
      retryLabel: "重试窗口（毫秒）",
      attemptsLabel: "最大尝试次数",
      outboxLabel: "每批重发数",
      claimSave: "保存",
      claimSaved: "已保存。",
      /** 写入失败且错误无法识别时的兜底文案。 */
      claimFailed: "修改评论触发恢复设置失败。",
      /** {retry}/{attempts}/{outbox} = 当前存储的设置（或文档默认值）。 */
      claimCurrent: "下一次扫描生效值：{retry} 毫秒后重试，最多 {attempts} 次，每次最多 {outbox} 条。",
      /** 所有已存储设置都无法读取——数字只是文档默认值。 */
      claimUnreadable:
        "无法读取已存储的评论触发恢复设置，因此正在使用文档默认值。输入范围内的值可保存为新值，重新读取会重新检查这些行。",
      /** App 未自行选择深度时继承的平台默认。 */
      reviewLevelTitle: "评审深度",
      reviewLevelDescription: "适用于尚未自行选择评审深度的 App。",
      reviewLevelLabel: "默认评审深度",
      reviewLevelQuick: "快速 — 单轮快速评审",
      reviewLevelStandard: "标准 — 均衡深度（推荐）",
      reviewLevelDeep: "深入 — 最彻底，耗时更长",
      reviewLevelSave: "保存",
      reviewLevelSaved: "已保存。",
      /** 写入失败且错误无法识别时的兜底文案。 */
      reviewLevelFailed: "修改默认评审深度失败。",
      /** 已存储的档位无法读取——显示的档位是文档默认值。 */
      reviewLevelUnreadable:
        "无法读取已存储的默认评审深度，因此未自行选择评审深度的 App 正在使用「标准」。选择档位可保存为新值，重新读取会重新检查该行。",
      /** 历史发现重审席位的提问预算。 */
      recheckTitle: "重审提问预算",
      recheckDescription:
        "历史发现重审席位单轮可索要的上下文大小（UTF-8 字节）。所有历史发现与讨论始终保留，证据切片在此预算内按序保留。",
      recheckLabel: "提问预算（字节）",
      recheckSave: "保存",
      recheckSaved: "已保存。",
      /** 写入失败且错误无法识别时的兜底文案。 */
      recheckFailed: "修改重审提问预算失败。",
      /** {value} = 当前存储的预算（或文档默认值）。 */
      recheckCurrent: "下一轮评审生效：{value} 字节。",
      /** 已存储的预算无法读取——显示的数值是文档默认值。 */
      recheckUnreadable:
        "无法读取已存储的重审提问预算，因此正在使用文档默认值。输入范围内的数值可保存为新值，重新读取会重新检查该行。",
      /** 流水线在最近 24 小时记录的准入拒绝。 */
      admissionDropsTitle: "准入拒绝（最近 24 小时）",
      admissionDropsDescription:
        "流水线拒绝准入的审查数量，按原因统计。被拒绝的审查从未开始；计数读取流水线已写入的失败记录。",
      /** 拒绝准入的原因：PR 锁、容量上限或存储故障。 */
      admissionDropsPrHeld: "PR 正在审查",
      admissionDropsSystemCap: "系统上限",
      admissionDropsWorkspaceCap: "工作区上限",
      admissionDropsError: "存储错误",
      /** 实时队列积压，以及最近 24 小时的 GitHub 次级限流次数。 */
      queueTitle: "队列积压与 GitHub 限流",
      queueDescription:
        "审查队列的实时积压，以及流水线在最近 24 小时记录的 GitHub 次级限流拒绝。“不可读”表示无法取得该计数，并不表示队列为空。",
      queueBacklogLabel: "积压深度",
      queueOldestLabel: "最旧消息",
      queueUnreadable: "不可读",
      /** 没有消息在排队，因此计数没有最旧时间戳。 */
      queueEmpty: "空队列",
      githubRateLimitedLabel: "GitHub 次级限流（24 小时）",
      // 部署版本页脚。{version} 为带 v 前缀的展示形（v${APP_VERSION}），
      // 与 /healthz 字段及 release tag 同形。
      version: "版本 {version}",
    },
    /** 工作区页。 */
    workspaces: {
      description: "所有在线工作区。更改套餐不会移除成员；降级只阻止新的邀请。",
      loadFailed: "无法加载工作区列表。",
      emptyTitle: "没有工作区",
      emptyDescription: "此部署还没有任何在线工作区。",
      workspaceColumn: "工作区",
      ownerColumn: "所有者",
      membersColumn: "成员",
      /** {count} = 待处理邀请数（仅大于 0 时渲染）。 */
      pendingInvites: "{count} 个待处理邀请",
      seatsColumn: "席位",
      planColumn: "套餐",
      createdColumn: "创建时间",
      /** 套餐写入失败且错误无法识别时的兜底文案。 */
      planChangeFailed: "无法更改 {name} 的套餐。",
      /** 套餐选择器的可访问名称。 */
      planAria: "{name} 的套餐",
      /** 套餐选择器中的目录标签，按线上套餐 id 索引。 */
      planFree: "免费版",
      planPro: "专业版",
      planUnlimited: "无限版",
      /** 打开 slug 对话框的行操作。 */
      slugAction: "编辑 slug",
      /** 行操作的可访问名称。 */
      slugAria: "编辑 {name} 的 slug",
      slugDialogTitle: "工作区 URL slug",
      slugDialogDescription:
        "此工作区控制台 URL 的可读部分。2–39 个小写字母、数字或连字符，以字母或数字开头。所有者已无法修改此项。",
      slugLabel: "Slug",
      slugSave: "保存 slug",
      cancelAction: "取消",
      /** slug 写入失败且错误无法识别时的兜底文案。 */
      slugChangeFailed: "无法更改 {name} 的 slug。",
    },
    /** 用户页。 */
    users: {
      description:
        "此平台上的所有账号。只读：运营身份来自白名单，支持访问来自授权列表。",
      loadFailed: "无法加载用户列表。",
      emptyTitle: "没有用户",
      emptyDescription: "还没有人登录过此平台。",
      githubColumn: "GitHub",
      firstSeenColumn: "首次登录",
      workspacesColumn: "工作区",
      identityColumn: "身份",
      identityOperator: "运营",
      /** {count} = 该登录名下的有效授权数。 */
      identitySupport: "支持（{count}）",
      identityUser: "用户",
    },
    /**
     * 客户端表格搜索（工作区、用户）：一个输入框过滤已加载的行；
     * 计数器显示“已显示 / 总数”。
     */
    search: {
      placeholder: "搜索",
      /** {shown} = 匹配行数，{total} = 已加载行数。 */
      counter: "{shown} / {total}",
      emptyTitle: "无匹配结果",
      emptyDescription: "没有符合当前搜索的行。",
    },
    /** 支持授权页 —— 列表表头与创建表单。 */
    supportGrants: {
      description: "限时的跨工作区访问。创建和撤销授权各追加一条审计记录。",
      loadFailed: "无法加载支持授权。",
      /** 写入失败且错误无法识别时的兜底文案。 */
      createFailed: "无法创建支持授权。",
      revokeFailed: "无法撤销支持授权。",
      newWindowTitle: "新建支持窗口",
      workspaceLabel: "工作区",
      workspacePlaceholder: "选择一个工作区",
      operatorLabel: "运营登录名",
      operatorPlaceholder: "octocat",
      reasonLabel: "原因",
      reasonPlaceholder: "incident 42",
      hoursLabel: "小时",
      submit: "授予访问",
      operatorColumn: "运营",
      workspaceColumn: "工作区",
      reasonColumn: "原因",
      expiresColumn: "过期时间",
      revokeAction: "撤销",
      emptyTitle: "没有开放的支持窗口",
      emptyDescription: "当前没有任何运营持有跨工作区访问。",
    },
  },
};
