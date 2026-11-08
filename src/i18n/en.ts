/**
 * English dictionary — the i18n source of truth.
 *
 * Contract:
 *   - `Dictionary` is derived from this object via `typeof en`; `zh-CN.ts`
 *     is typed as `Dictionary`, so a missing (or extra) key is a compile
 *     error. The runtime key-set parity test in tests/i18n/i18n.test.ts is
 *     the belt-and-suspenders check.
 *   - Values are PLAIN TEXT (no HTML entities, no markup). Consumers escape
 *     before rendering — SSR pages via escapeHtml, the SPA via JSX.
 *   - `{placeholder}` tokens are interpolated by `t(locale, key, params)`.
 *   - This is the single string table for the whole dashboard: later
 *     feature work APPENDs keys here — they never start a
 *     second table.
 *   - The `notice` slot mirrors the `PageNotice` type (kind × message);
 *     after the dead-key purges it carries only the member-flow
 *     messages (the retired SSR settings routes rendered plain text).
 *   - Manifest copy deliberately carries no deployment-level review switch
 *     copy (per-App pause is the only switch).
 */
export const en = {
  nav: {
    brand: "Morning Star Inspector",
    primary: "Primary navigation",
    apps: "Apps",
    members: "Members",
    settings: "Settings",
    /** Sidebar-footer entry to the platform console (operators on `saas`). */
    platformOperations: "Platform operations",
    /** Label of the OTHER locale — the toggle target (en shows 中文, zh_CN shows EN). */
    language: "中文",
    /** Theme toggle: icon-only button; state + action live in the aria copy. */
    /** {mode} = current effective theme, {target} = the theme clicking switches to. */
    themeToggleAria: "Display theme: {mode}. Activate to switch to {target}.",
    themeDark: "dark",
    themeLight: "light",
    logout: "Logout",
    signedInAs: "Signed in as {name}",
    /** Label of the shell's workspace switcher (the select itself shows names). */
    workspaceSwitcher: "Workspace",
    /** The switcher menu's last row — the workspace-creation entry. */
    newWorkspace: "New workspace",
    /**
     * Why the new-workspace item is disabled (`createWorkspaceBlockedReason:
     * "free_slot"`): this login already holds its one free workspace.
     */
    newWorkspaceBlockedFreeSlot:
      "You already belong to a free workspace — one per login. Delete it, or ask its owner to remove you, then create another.",
    /**
     * Why the new-workspace item is disabled (`createWorkspaceBlockedReason:
     * "flag"`): the operator closed workspace creation platform-wide.
     */
    newWorkspaceBlockedFlag: "Workspace creation is closed on this platform right now.",
  },
  common: {
    pageTitle: "{page} — {brand}",
    time: {
      justNow: "just now",
      minuteAgo: "{count} minute ago",
      minutesAgo: "{count} minutes ago",
      hourAgo: "{count} hour ago",
      hoursAgo: "{count} hours ago",
      dayAgo: "{count} day ago",
      daysAgo: "{count} days ago",
      /** Future tense (formatUntil) — the usage panel's reset stamps. */
      inMinute: "in {count} minute",
      inMinutes: "in {count} minutes",
      inHour: "in {count} hour",
      inHours: "in {count} hours",
      inDay: "in {count} day",
      inDays: "in {count} days",
      never: "never",
      unknown: "unknown",
    },
    error: {
      removedTitle: "Access removed",
      removedBody: "Your dashboard access was removed. Ask an admin to re-invite {login}.",
      forbiddenTitle: "Forbidden",
      forbiddenBody:
        "This page is restricted to dashboard admins. You are signed in as {login} — back to /dashboard.",
      notFoundTitle: "Not found",
      notFoundBody:
        "This page does not exist, or it is not available in this workspace. Back to /dashboard.",
      signInErrorTitle: "Sign-in error",
      signInErrorBody:
        "Sign-in failed. {message} No session was created. Return to /dashboard/login to try again.",
    },
    oauth: {
      stateInvalid: "Sign-in could not be verified (bad or expired state).",
      missingCode: "GitHub did not return an authorization code.",
      codeRejected: "GitHub rejected the authorization code.",
      profileFailed: "Could not read your GitHub profile.",
      /** `signup_open` is off: an unknown login cannot create an account. */
      signupClosed: "Sign-up is closed on this platform right now.",
    },
    loading: "Loading…",
    loadFailed: "Could not load this page.",
    saveFailed: "Could not save your changes.",
    cancel: "Cancel",
    retry: "Retry",
  },
  login: {
    heading: "Sign in",
    description: "Use your GitHub account to access the console.",
    signIn: "Sign in with GitHub",
    /** Sign-in is open — no access list stands between here and a workspace. */
    openAccess: "Any GitHub account can sign in — create a workspace, or accept an invitation.",
  },
  notice: {
    success: {
      invited: "Invited {login} — they can accept from this workspace now.",
      removedMember: "Removed {login}.",
      roleChanged: "{login} is now {role}.",
      revoked: "Revoked the invitation for {login}.",
      workspaceDeleted: "Workspace deleted. Its Apps are not reviewed.",
    },
    warn: {
      alreadyMember: "{login} is already a member — nothing changed.",
      invitePending: "{login} already has a pending invitation — nothing changed.",
      workspaceUnavailable: "This workspace is no longer available to you.",
    },
    error: {
      enterLogin: "Enter a GitHub login to invite.",
      invalidLogin: "{login} is not a valid GitHub login — use 1–39 letters, digits, or hyphens.",
      inviteFailed: "Could not invite {login} — try again.",
      roleChangeFailed: "Could not change {login}'s role — the member list just changed, try again.",
      removeFailed: "Could not remove {login} — the member list just changed, try again.",
      revokeFailed: "Could not revoke {login}'s invitation — try again.",
    },
  },
  /** App detail page (App detail IA): the tabbed shell. */
  appDetail: {
    backToApps: "Back to Apps",
    tabSettings: "Settings",
    tabInstallations: "Installed",
    tabInsights: "Insights",
    tabPullRequests: "Pull requests",
  },
  /**
   * Per-App Pull requests tab: the ledger of every PR the App received.
   * The detail face is addressed by owner/repo/number (one App can see the
   * same number on several repos) and rides the URL as `pr=owner/repo/number`.
   */
  pullRequests: {
    backToList: "Back to list",
    /** Toolbar row above the ledger (list face only). */
    filterRepo: "Repository",
    filterRepoAll: "All repositories",
    refreshAria: "Refresh the pull request list",
    /** The list table's columns — the row's own facts only. */
    columnPr: "Pull request",
    columnState: "State",
    columnVerdict: "Latest verdict",
    columnLastSeen: "Last seen",
    columnFailures: "Failures",
    /** Composed empty state — no-action variant (PRs arrive via webhooks). */
    emptyTitle: "No pull requests yet",
    emptyDescription: "Every pull request your GitHub App receives shows up here.",
    state: {
      open: "open",
      closed: "closed",
      merged: "merged",
    },
    /** The detail header line: `{owner}/{repo} #{number}`. */
    prNumber: "{owner}/{repo} #{number}",
    /** The header line's accessible name: the PR's GitHub address. */
    openOnGithub: "Open {owner}/{repo}#{number} on GitHub",
    /** The aside repo value's accessible name: the repository's GitHub address. */
    openRepoOnGithub: "Open {owner}/{repo} on GitHub",
    /** The review row's commit link: names the commit the short sha opens. */
    openCommitOnGithub: "Open commit {sha} on GitHub",
    /** The short-sha chip's tooltip. */
    headSha: "Head SHA",
    reviews: "Reviews",
    noReviews: "No reviews for this pull request.",
    reviewMeta: "{model} · {provider}",
    /** A review row's round ordinal. The findings row reuses it for the round that first reported the finding. */
    reviewRound: "Round {round}",
    /** A round's wall clock: sub-minute runs read in seconds, longer ones as m/s. */
    reviewDurationSeconds: "{seconds}s",
    reviewDurationMinutes: "{minutes}m {seconds}s",
    /** The run-time span's tooltip, like the head-sha chip's: names what the value measures. */
    reviewDurationLabel: "Round run time",
    failures: "Failures",
    noFailures: "No failures for this pull request.",
    findings: "Findings",
    noFindings: "No findings for this pull request.",
    /** A filtered findings window with no match: it names the active severity,
        not the PR (the head count still says the PR has findings). */
    noFindingsForSeverity: "No findings with severity {severity}.",
    /** The detail header's meta line. */
    firstSeen: "First seen",
    lastSeen: "Last seen",
    latestReview: "Latest review",
    /** The verdict metric's screen-reader text when no review exists yet. */
    noVerdict: "no verdict yet",
    /** The D11 reviewing marker: a LIVE review lock, carrying the attempt's
        head sha, or its acquisition time when a comment trigger carried none. */
    reviewingHead: "Reviewing now · {head}",
    reviewingSince: "Reviewing now · {time}",
    /** A failed inflight read: neither the reviewing badge nor a confident idle. */
    reviewingUnknown: "Review state unknown",
    reviewingUnknownHint: "The review state could not be read.",
    /** The segmented pill over the three record families. */
    recordsLabel: "Pull request records",
    /** A family trigger's accessible name: its label and the count it paints. */
    familyTabName: "{label} ({count})",
    /** The findings metric's note, rendered beside the count. */
    mustFixNote: "{count} must-fix",
    /** The findings filter's label and its "no filter" choice. */
    filterSeverity: "Severity",
    filterAll: "All",
    /** The pager under a record list: prev/next and the loaded range over the total. */
    pagePrev: "Previous",
    pageNext: "Next",
    pageRange: "{from}–{to} / {total}",
    /**
     * Beside the range: rows this page's parser refused. They stay inside
     * `total`, so the list cannot reach them from any window.
     */
    pageDropped: "{count} rows could not be shown",
    /**
     * A severity group's count. The groups are built from the loaded window,
     * while the tab's count is the PR's whole total — so the header names
     * which one it counts.
     */
    groupPageCount: "{count} on this page",
    /** Severity group headers, in the order the groups render. */
    severityMustFix: "Must fix",
    severityShouldFix: "Should fix",
    severityMayFix: "May fix",
    severityNit: "Nit",
    severityOther: "Other",
    /** One fold control per finding body. */
    expand: "Expand",
    collapse: "Collapse",
    /** A fold control's accessible name: the action, the record and its position. */
    foldLabel: "{action} — {record} · #{position}",
    /** The same name for a record with no identity text: its position alone. */
    foldLabelBare: "{action} — #{position}",
    /** The failure block's remaining-output fold (the diagnosis above is the first line) and copy action. */
    failureRemainingOutput: "Remaining output",
    copyError: "Copy error",
    /** The copy action's transient outcome, shown on the button for a couple of seconds. */
    copyCopied: "Copied",
    copyFailed: "Copy failed",
    /** The aside: PR facts and the merged activity timeline. */
    asideFacts: "Pull request",
    asideActivity: "Activity",
    factRepo: "Repo",
    factNumber: "Number",
    factState: "State",
    factHead: "Head",
    timelineReview: "Review · {verdict}",
    /** A review whose verdict the payload did not record: the row still renders, without a dangling separator. */
    timelineReviewNoVerdict: "Review · no verdict",
    timelineFailure: "Review failed · {stage}",
    /** A failure whose payload recorded no stage: the row still renders, without a dangling separator. */
    timelineFailureNoStage: "Review failed",
    timelineFirstSeen: "PR first seen",
    /** The trailing row when the cap dropped older events (count reads correctly at 1). */
    timelineHidden: "Earlier events not shown: {count}",
  },
  /**
   * Per-App insights tab (the 洞察 face). The records copy returns with
   * the per-App successor of the retired global insights page — the
   * 7/30/90 window segments and repo filter semantics are unchanged.
   */
  insights: {
    heading: "Review health",
    window: "Window: {label}",
    reviewsTotal: "Reviews: {count}",
    verdicts: "Verdicts: {line}",
    noReviews: "No reviews in this window.",
    findingsBySeverity: "Findings by severity",
    trend: "Trend",
    noFindings: "No findings in this window.",
    finding: "{count} finding",
    findings: "{count} findings",
    review: "{count} review",
    reviews: "{count} reviews",
    lastDay: "last {count} day",
    lastDays: "last {count} days",
    repo: "repo {repo}",
    windowSegment: "Time window",
    daysShort: "{count}d",
    filterRepo: "Repo",
    filterRepoAll: "All",
    seriesReviews: "Reviews",
    seriesFindings: "Findings",
    trendSummary: "In this window: {reviews} · {findings}",
    /** Composed zero-review empty state — no-action variant (reviews arrive via installed Apps). */
    emptyTitle: "No reviews yet",
    emptyDescription: "Insights fill in as your installed GitHub Apps review pull requests.",
  },
  apps: {
    heading: "Apps",
    /** The header band's one-line description (DESIGN.md header band). */
    headingDescription: "Each row is one GitHub App; installation scope lives on the App detail.",
    create: "Create GitHub App",
    /**
     * The metric band. Four figures, each proved by `AppsPayload`: the App
     * count, the count whose status is not `disabled` (the enable/disable
     * axis — a paused App is still enabled), the count whose `review_enabled`
     * is 0 (the pause axis, the field's own value), and the sum of
     * `health.rejected24h`. Installation and repository counts are not fields
     * of that payload and are never shown (compass D13).
     */
    metricApps: "Apps",
    metricEnabled: "Enabled",
    metricReviewOff: "Review off",
    metricRejected24h: "24h rejected",
    /**
     * Why the Create control is disabled. `role`: the caller is not
     * owner/admin of the workspace the page addresses. `workspace`: this
     * deployment carries several workspaces and the page names none.
     */
    createUnavailable: {
      role: "Only a workspace owner or admin can create an App here.",
      workspace: "Open a workspace first — this deployment has more than one, so an App needs to know which it belongs to.",
    },
    /** Composed empty state (EmptyState title + description). */
    emptyTitle: "No Apps yet",
    emptyDescription: "Create GitHub App connects your first one.",
    detail: "Detail",
    appId: "App id {id}",
    by: "by {login}",
    status: {
      active: "active",
      disabled: "disabled",
      paused: "paused",
    },
    actions: {
      pause: "Pause",
      resume: "Resume",
      disable: "Disable (reversible)",
      enable: "Enable",
      delete: "Delete",
    },
    health: {
      delivery: "delivery {time}",
      deliveryNever: "delivery never",
      rejected24h: "{count} rejected in 24h",
      outcome: {
        ok: "OK",
        paused: "Paused",
        ignored: "Ignored",
        rejected: "Rejected",
      },
    },
    tableName: "App",
    tableStatus: "Status",
    tableHealth: "Health",
    tableCreator: "Creator",
    openAria: "Open {name} detail",
  },
  members: {
    heading: "Members",
    visibleToMembers: "Everyone in this workspace can see who is a member.",
    /** The "This workspace" block — plan, seats and the month's meter. */
    workspaceHeading: "This workspace",
    planLabel: "Plan",
    planFreeHint: "BYOK only",
    membersLabel: "Members",
    memberSeats: "{count} / {limit}",
    slotsLeft: "{count} slots left",
    slotsLeftOne: "{count} slot left",
    noSeatsLeft: "No seats left",
    noMemberLimit: "No limit",
    pendingInviteOne: "{count} pending invitation",
    pendingInvites: "{count} pending invitations",
    reviewAttemptsLabel: "Review attempts this month",
    reviewAttemptsHint: "Counted, not limited.",
    /** Owner-only workspace deletion: entry, confirmation body and refusal. */
    deleteWorkspace: "Delete workspace",
    deleteWorkspaceTitle: "Delete this workspace?",
    deleteWorkspaceBody:
      "This cannot be undone. Members will lose access, pending invites will be cancelled, and Apps in this workspace will no longer be reviewed. A review that has already started is not cancelled.",
    deleteWorkspaceFailed: "Could not delete the workspace — try again.",
    deleteWorkspaceNotOwner: "Only the workspace owner can delete it.",
    inviteLabel: "Invite by GitHub login",
    invitePlaceholder: "e.g. octocat",
    inviteButton: "Invite member",
    roleLabel: "Role",
    tableLogin: "GitHub login",
    tableJoined: "Joined",
    tableExpires: "Expires",
    tableActions: "Actions",
    actionsMenuLabel: "Open actions for {login}",
    makeAdmin: "Change to admin",
    makeMember: "Change to member",
    confirmRoleTitle: "Change {login}'s role?",
    confirmRoleBody: "{login} will become {role}. The change takes effect immediately.",
    confirmRoleButton: "Change role",
    confirmRemoveTitle: "Remove {login}?",
    confirmRemoveBody:
      "{login} will no longer be able to sign in — their session stops working right away. Apps they created stay in place and remain manageable by admins.",
    remove: "Remove",
    pendingHeading: "Pending invitations",
    confirmRevokeTitle: "Revoke {login}'s invitation?",
    confirmRevokeBody: "{login} will not be able to accept this invitation. They can be invited again later.",
    revoke: "Revoke",
    you: "you",
    /** Workspace role vocabulary (`workspace_members.role`), including owner. */
    role: {
      owner: "owner",
      admin: "admin",
      member: "member",
    },
    /** Composed empty state — no-action variant (the invite form is the path). */
    emptyTitle: "No members yet",
    emptyDescription: "Invite the first member with the form above.",
    emptyDescriptionMember: "This workspace has no other members yet.",
  },
  /**
   * Workspace creation — the signed-in landing for a login that belongs to no
   * workspace yet. Sign-in joins nobody, so this is the only path
   * into a first workspace besides accepting an invitation.
   */
  workspace: {
    /** The `/dashboard/<ref>/settings` page title. */
    settingsHeading: "Workspace settings",
    setupHeading: "Create a workspace",
    setupDescription:
      "You are not a member of a workspace yet. Create one and you become its owner — you can invite teammates afterwards.",
    /**
     * The switcher menu's creation dialog: the same POST, opened by
     * a member who already has a workspace — so it cannot claim "no workspace
     * yet", and it makes no plan statement (the surface is not mode-gated).
     */
    createDialogDescription: "Name it and you become its owner — you can invite teammates afterwards.",
    /**
     * The `self-hosted` empty-instance line: this sign-in created the
     * deployment's first account. Absent on `saas` and once `users` is
     * non-empty.
     */
    emptyInstance:
      "This instance has no accounts yet. Your login is now this instance's first account — create a workspace to start.",
    nameLabel: "Workspace name",
    namePlaceholder: "e.g. Acme",
    create: "Create workspace",
    nameRequired: "Enter a workspace name.",
    nameTooLong: "Use at most {max} characters.",
    createFailed: "Could not create the workspace — try again.",
    /** Pending invitations on the creation surface — the invitee's accept path (MF-2). */
    invitesHeading: "Workspace invitations",
    invitesDescription: "Accept an invitation to join that workspace, or create your own below.",
    inviteAccept: "Accept",
    /** {role} = the invited workspace role; {expires} = the relative expiry stamp. */
    inviteMeta: "Invited as {role} — expires {expires}",
    inviteExpired: "This invitation has expired.",
    inviteGone: "This invitation is no longer pending — it may have been revoked.",
    inviteAcceptFailed: "Could not accept the invitation — try again.",
    /** The manager gate on `/dashboard/<ref>/settings` — a plain member sees it. */
    settingsOwnerOnly: "Only workspace owners and admins can change these settings.",
    /** The owner's name card — the label the top-bar switcher shows. */
    nameHeading: "Workspace name",
    nameDescription:
      "The label in the top-bar workspace switcher. This workspace's URL is its id and does not change.",
    nameSave: "Save name",
    nameSaved: "Workspace name updated.",
    nameFailed: "Could not change the workspace name — try again.",
    /** The owner/admin concurrency card (iteration spec §1.1). */
    concurrencyHeading: "Review concurrency",
    concurrencyDescription: "How many reviews this workspace may run at once. The platform can further limit it.",
    concurrencyLabel: "Concurrent reviews",
    concurrencySave: "Save concurrency",
    concurrencySaved: "Review concurrency updated.",
    concurrencyFailed: "Could not change the review concurrency — try again.",
    /** {min}/{max} = this workspace's own range. */
    concurrencyRange: "Accepts {min}–{max}.",
    /** The owner/admin review-gate default card for Apps connected later. */
    checkMinScoreHeading: "Review gate default",
    checkMinScoreDescription:
      "The score floor a newly connected App starts at. Existing Apps keep their own floor; change it on that App's settings page.",
    checkMinScoreLabel: "Default score floor",
    checkMinScoreSave: "Save default",
    checkMinScoreSaved: "Review gate default updated.",
    checkMinScoreFailed: "Could not change the review gate default — try again.",
    /** {min}/{max} = the accepted range. */
    checkMinScoreRange: "Accepts {min}–{max}.",
    /** {min}/{max} = the accepted range; the shown number is the fallback. */
    checkMinScoreUnreadable:
      "The stored default could not be read, so new Apps use the platform default. Saving a value from {min} to {max} sets this workspace's default, and retrying the read refreshes it; if the warning returns after a reload, ask your platform operator.",
    /** {min}/{max} = this workspace's own range; the shown numbers are the fallback. */
    concurrencyUnreadable:
      "The stored review concurrency could not be read, so reviews may be running one at a time. The numbers shown are a fallback. Saving a value from {min} to {max} sets this workspace's value, and retrying the read refreshes it; if the warning returns after a reload, ask your platform operator.",
  },
  /**
   * Platform-operator support (2026-10): the operator's read-only face and the
   * tenant's undismissable grant notice. The notice states who is looking, why,
   * and until when — and offers no action, because the tenant can neither end
   * nor edit a grant.
   */
  support: {
    heading: "Support access",
    readOnly: "You are viewing this workspace under a time-boxed support grant. Everything here is read-only.",
    workspaceId: "Workspace id",
    createdAt: "Created",
    grantsHeading: "Active support grants",
    grantLine: "{login} has support access until {expires} — {reason}",
    tableLogin: "GitHub login",
    tableRole: "Role",
    /** The tenant's always-on notice; not dismissible, carries no action. */
    noticeHeading: "Support access is active",
    noticeLine: "{login} can read this workspace's members until {expires} — {reason}",
    noticeError: "Could not check for active support access.",
    noGrant: "No support access is active.",
  },
  settings: {
    changesSaved: "Changes saved.",
    removeNoChange: "Nothing changed — there was nothing to remove.",
    addKey: "Add key",
    provider: "Model provider",
    apiKey: "API key",
    apiKeyPlaceholder: "Paste the provider API key",
    keyEnding: "key ending {last4}",
    keyTooShort: "key too short to show a tail",
    updated: "updated {time}",
    remove: "Remove",
    selectProvider: "Search model providers…",
    noProviderMatch: 'No providers match "{query}".',
    modelChainField: "Model chain",
    saveChain: "Save model chain",
    providerId: "Provider id",
    baseUrl: "Base URL",
    api: "API",
    modelIds: "Model ids",
    addCustomProvider: "Add custom provider",
    selectApi: "Select an API…",
    roleHintReviewSeat: "quick + default review seats",
    roleHintDeep: "deep review seat",
    saveRoleModels: "Save seat chains",
    pauseReviews: "Pause reviews",
    resumeReviews: "Resume reviews",
    disconnected: "This App is disconnected — enable it to review.",
    lastWebhook: "Last webhook: {time}",
    /**
     * The installations section of the settings flow: heading, count subtitle
     * and the table's four columns (the availability badge is derived from
     * the stored owner allowlist, migration 0045). `installations.length`
     * is the only installation figure the product carries (compass D13); the
     * settings payload has no per-installation repository count, so there is
     * no repository column.
     */
    installations: "Installations",
    installationsCount: "{count} installations",
    installationsCountOne: "{count} installation",
    installationsAccount: "Account",
    installationsAvailability: "Availability",
    availabilityValid: "Valid",
    availabilityInvalid: "Invalid",
    installationsId: "Installation ID",
    installationsLastSync: "Last sync",
    /** Metric-band label for the provider-key count on the App detail face. */
    metricKeys: "Keys",
    noInstallations: "No installations yet.",
    recentDeliveries: "Recent deliveries",
    recentDeliveriesCopy:
      "Up to 10 webhook deliveries — outcomes that report a verdict (OK / Paused / Rejected) come first, then the rest newest first.",
    noDeliveries: "No deliveries yet.",
    unknownEvent: "unknown event",
    unknownSource: "unknown repo",
    status: "status {code}",
    addToChain: "Add to chain",
    noAutoDiscovery: "This provider does not list models — pick from another verified provider.",
    noVerifiedModels: "Verify a provider key to populate model options.",
    chainEmpty: "No models in the chain yet.",
    pickModel: "Select a model…",
    keyVerified: "Key verified — models cached.",
    verify: {
      invalid_key: "That API key was rejected by the provider — nothing was stored.",
      quota_exhausted:
        "That provider account is out of quota or credit — nothing was stored. The key itself may still be valid.",
      rate_limited:
        "The provider throttled the verification request — nothing was stored, and the key was not judged. Retry shortly; if it keeps happening, the account may genuinely be out of quota.",
      unreachable: "The provider could not be reached — nothing was stored.",
      unexpected: "The provider returned an unexpected response — nothing was stored.",
      unsupported_provider:
        "This provider can't be verified here — manage the key in the provider console. Nothing was stored.",
    },
    membership: {
      not_in_verified_models: "Selector {selector} is not in this App's verified models.",
    },
    /**
     * Machine-readable 400 faces for the settings POST family.
     * The worker emits `{ key, message, params? }` — `message` is this en
     * face (interpolated server-side, also the fallback when the SPA does
     * not know the key); the SPA resolves `key` in the operator's locale.
     * Faces match the route's former inline literals byte-for-byte except
     * `customProviderDeclRejected` (the store-backstop 400, whose former
     * face was the thrown error's developer text).
     */
    error: {
      providerRequired: "Pick a provider for the key.",
      providerUnknown: "{provider} is not a supported provider — pick one from the list.",
      providerUnavailableOnHarness:
        "{provider} is not available under this App's selected runtime harness ({image}) — nothing was stored.",
      apiKeyRequired: "Enter an API key to store.",
      apiKeyTooLong:
        "That API key is too long ({count} characters) — keys are limited to {limit} characters. Nothing was stored.",
      apiKeyCommandPrefix:
        "That API key starts with \"!\" — the review runtime would run it as a shell command, so keys of that shape are refused. Nothing was stored.",
      providerKeyLimit:
        "{provider} already holds the maximum of {limit} keys — remove one before adding another. Nothing was stored.",
      chainFieldDuplicated: "The model chain field was submitted more than once — resubmit the form. Nothing was saved.",
      chainTooLong: "That model chain is too long ({count} characters) — limited to {limit} characters. Nothing was saved.",
      chainEmpty: "Enter at least one comma-separated model selector.",
      roleFieldDuplicated:
        "The {field} field was submitted more than once — resubmit the Role models form with one value per role. Nothing was saved.",
      roleUnknown: "{role} is not a known review role — nothing was saved.",
      roleFieldsMissingAll: "No role chain references were submitted — resubmit the Role models form.",
      roleFieldMissing:
        "The {roles} role field is missing — the Role models form always saves every seat (blank = default chain). Nothing was saved.",
      roleFieldsMissing:
        "The {roles} role fields are missing — the Role models form always saves every seat (blank = default chain). Nothing was saved.",
      roleChainUnknown:
        "{role} is not a known model chain — pick one from the list or leave it empty to use the default chain. Nothing was saved.",
      chainNameInvalid:
        "Chain names must be 1–{limit} lowercase letters, digits or hyphens — and \"default\" is reserved. Nothing was saved.",
      chainValueRequired: "Enter a model chain for the named chain.",
      defaultChainRemoveProtected: "The \"default\" chain cannot be removed — clear it instead. Nothing was saved.",
      providerIdRequired: "Enter a provider id for the custom provider.",
      providerIdInvalid:
        "Provider ids are lowercase letters, digits, and hyphens — 1 to 64 characters, starting with a letter or digit. Nothing was stored.",
      providerIdBuiltin: "{provider} is a built-in provider — custom providers must use a new id. Nothing was stored.",
      providerIdBaseConfig:
        "{provider} is already provided by the review environment's base configuration — custom providers must use a new id. Nothing was stored.",
      customProviderMax:
        "This App already has the maximum of {limit} custom providers — remove one before declaring another (updating an existing declaration is always allowed). Nothing was stored.",
      baseUrlRequired: "Enter the provider's base URL.",
      baseUrlInvalid: "The base URL must be a valid https URL with a host — nothing was stored.",
      baseUrlTooLong:
        "That base URL is too long ({count} characters) — limited to {limit} characters. Nothing was stored.",
      apiProtocolRequired: "Pick an API protocol for the custom provider.",
      apiProtocolUnknown: "{api} is not a supported API protocol — pick one from the list. Nothing was stored.",
      modelIdsRequired: "Enter at least one model id for the custom provider.",
      modelIdsTooMany: "Too many model ids ({count}) — at most {limit}. Nothing was stored.",
      modelIdTooLong: "Model ids are limited to {limit} characters each. Nothing was stored.",
      customProviderDeclRejected: "The custom provider was rejected — nothing was stored.",
      customProviderUndeclared:
        "{provider} is not a declared custom provider for this App — declare it before adding keys. Nothing was stored.",
      providerEndpointLocked:
        "{provider} already stores keys for its current endpoint — remove them before changing its base URL or API protocol. Nothing was stored.",
      templateUnknown: "Unknown provider template — nothing was stored.",
      templateIncomplete: "This provider template is incomplete — nothing was stored.",
      accountIdRequired: "Enter your Cloudflare account id to complete the Workers AI base URL.",
      accountIdInvalid: "Cloudflare account ids are 32 hex characters — nothing was stored.",
      templateIdBuiltin: "{template} is a built-in provider — nothing was stored.",
      templateIdBaseConfig:
        "{template} is already provided by the review environment's base configuration — nothing was stored.",
      materializedBaseUrlInvalid: "The materialized base URL is not a valid https URL — nothing was stored.",
      templateApiUnsupported: "{api} is not a supported API protocol — nothing was stored.",
      templateNoModels: "This provider template has no model ids — nothing was stored.",
      templateMaterializeMax:
        "This App already has the maximum of {limit} custom providers — remove one before materializing another (updating an existing declaration is always allowed). Nothing was stored.",
      runtimeHarnessUnknown: "Unknown or disabled runtime harness — nothing was stored.",
      triggerModeUnknown: "{mode} is not a review trigger mode — use open, every_push, or manual. Nothing was stored.",
      reviewLevelUnknown:
        "{level} is not a review depth — use quick, default, or deep (or inherit to follow the operator default). Nothing was stored.",
      checkScoreInvalid: "The review gate score must be a whole number from {min} to {max}. Nothing was stored.",
      checkVerdictUnknown:
        "{verdict} is not a review verdict — use one of: {verdicts}. Nothing was stored.",
      allowlistToggleInvalid: "The owner allowlist switch must be on or off. Nothing was stored.",
      allowlistTooManyOwners:
        "The owner allowlist accepts at most {limit} owners — nothing was stored. Remove some logins and resubmit.",
      allowlistInvalidOwner:
        "{owner} is not a valid GitHub login — use 1–39 letters, digits, or hyphens. Nothing was stored.",
      fieldDuplicated:
        "The {field} field was submitted more than once — resubmit the form with one value. Nothing was saved.",
      unknownOperation: "Unknown settings operation — resubmit one of this page's forms.",
      githubMetadataRefreshFailed:
        "GitHub did not return the App's metadata — nothing was refreshed. Check the App still exists, then retry.",
      concurrencyInvalid: "Concurrency must be a whole number from {min} to {max}. Nothing was stored.",
      /** Usage probe's off-vendor refusal: the declaration's host is not one the probe calls. */
      usageProbeOffVendorHost:
        "The usage probe for {provider} only calls the vendor's own quota host; this declaration points at {host}.",
      /** Same refusal when the declaration yields no readable host at all. */
      usageProbeUnreadableEndpoint:
        "The usage probe for {provider} only calls the vendor's own quota host; this declaration points at an endpoint that cannot be read.",
    },
    ops: "Operations",
    opsCopy: "These actions change how this App answers incoming deliveries.",
    // The danger zone's per-action rows: the row says what its control does to
    // deliveries; the confirm dialogs keep their own proceed-or-not bodies.
    opsReviewsTitle: "Review deliveries",
    opsReviewsCopy:
      "While paused, every delivery is answered 2xx and ignored — nothing is reviewed. Resuming puts this App back to reviewing.",
    opsDeliveryTitle: "Delivery responses",
    opsDeliveryCopy:
      "A disabled App answers 404 to every delivery, so nothing is reviewed. Enabling it puts this App back to reviewing.",
    opsDeleteTitle: "Delete this App",
    opsDeleteCopy: "A soft delete — the App leaves this list and every installation is closed.",
    // Review trigger mode (spec review-trigger-policy §2/§3): segment
    // labels localize; the wire values (open / every_push / manual) and the
    // mention string stay verbatim.
    triggerMode: "Review trigger",
    triggerModeOpen: "First open",
    triggerModeEveryPush: "Every push",
    triggerModeManual: "Manual",
    triggerModeMention: "PR author or repo owner: comment this on the PR to (re-)start a review:",
    triggerModeMentionAria: "Bot mention: {mention}",
    // Review depth (migration 0047): the four faces of the App's depth select.
    // Wire values stay quick/default/deep (plus the inherit face's own
    // sentinel); only the labels localize. "Standard" is the `default` enum's
    // tenant-facing name — a degree word beside Quick and Deep.
    reviewDepth: "Review depth",
    reviewDepthCopy:
      "How thoroughly each review of this App runs. Quick is the cheapest; Deep is the most thorough.",
    reviewDepthQuick: "Quick",
    reviewDepthQuickHint: "fast, single-pass review",
    reviewDepthStandard: "Standard",
    reviewDepthStandardHint: "balanced depth (recommended)",
    reviewDepthDeep: "Deep",
    reviewDepthDeepHint: "most thorough, slower",
    reviewDepthInherit: "Follow operator default (currently {level})",
    confirmPauseTitle: "Pause reviews for {slug}?",
    confirmPauseBody: "Webhooks stay connected — deliveries are answered and ignored until you resume.",
    confirmResumeTitle: "Resume reviews for {slug}?",
    confirmResumeBody: "This App will review pull requests again.",
    confirmDisableTitle: "Disable {slug}?",
    confirmDisableBody: "GitHub deliveries will get 404 until you enable it again.",
    confirmDisableAction: "Disable",
    confirmEnableTitle: "Enable {slug}?",
    confirmEnableBody: "This App will accept webhook deliveries again.",
    confirmDeleteTitle: "Delete {slug}?",
    confirmDeleteBody: "This is a soft-delete. The App disappears from the list; reviews fail closed.",
    confirmDeleteButton: "Delete App",
    deleteSuccess: "App deleted. It has been removed from the Apps list.",
    providers: {
      title: "Providers",
      /** AC-10: exactly one verification label per key row, from the four store states. */
      status: {
        ok: "Verified",
        reachable: "Endpoint reachable",
        failed: "Verification failed",
        unverified: "Not verified",
      },
      tier: { builtin: "Built-in", template: "Template", custom: "Custom" },
      summary:
        "{total} keys · {ok} verified · {reachable} endpoint reachable · {failed} failed · {unverified} unverified",
      /** The singular pair (the `members.slotsLeftOne` convention: no plural helper). */
      summaryOne:
        "{total} key · {ok} verified · {reachable} endpoint reachable · {failed} failed · {unverified} unverified",
      /** AC-11: the secondary timestamp slot — never part of the status label. */
      verifiedAt: "verified {time}",
      modelCount: "{count} models",
      modelCountOne: "{count} model",
      /**
       * The model picker: the meta-line trigger, the dialog faces, and the
       * model-id cap stated in the counter. `common` has no save key — the
       * picker's save label lives here.
       */
      models: {
        trigger: "Edit models",
        title: "Models for {label}",
        searchLabel: "Filter model ids",
        searchPlaceholder: "Filter model ids…",
        selectAll: "Select all",
        selectNone: "Select none",
        counter: "{selected} / {max} selected — at most {max} model ids per provider.",
        capReached: "At the {max}-model cap — uncheck one to add another.",
        noMatch: 'No models match "{query}".',
        save: "Save models",
      },
      /** The two-step add-provider dialog: its indicator, its back step and its in-progress copy. */
      stepPick: "Choose",
      stepConfigure: "Configure",
      back: "Back",
      verifying: "Verifying…",
      saving: "Saving…",
      /** Add-key dialog: its title, its pool usage line, and the key ceiling. */
      addKeyTo: "Add a key to {label}",
      keyUsage: "{count} of {limit} keys stored.",
      keyLimitReached: "This provider already holds {limit} keys — remove one before adding another.",
      expand: "Expand",
      collapse: "Collapse",
      empty: "No keys yet — add the first key to use this provider in a model chain.",
      /**
       * Console-only branch: the built-in id is reserved by the store, so a
       * user-supplied endpoint lives on a declaration with its own id. The
       * copy never claims the provider console is the only path.
       */
      customEndpoint: "Configure a custom endpoint",
      customEndpointCopy:
        "{provider}'s built-in id is reserved — a custom endpoint needs its own id. This opens the declaration form with the provider's API protocol and base-URL shape filled in.",
      customIdRequired: "{provider} is taken — enter a new id for this declaration.",
      submitFailed: "That request failed before it reached the server — nothing was stored.",
      /**
       * The per-key usage probe: the key-row action, the inline panel it
       * reveals under the row, and the four faces — ok (window bar /
       * balance), unauthorized, absent, error. The wire's diagnostic
       * `reason` never renders verbatim.
       */
      usage: {
        action: "Usage",
        error: "Could not read this key's usage right now.",
        unauthorized: "The provider rejected this key — it may be revoked or expired.",
        absentNoProbe: "This provider has no usage probe.",
        absentNothing: "The provider reported no usage window for this key.",
        windowRemaining: "{percent}% remaining",
        resets: "resets {time}",
        balanceRemaining: "{amount} {unit} remaining",
        /** Credits held beside the pool in the same cell: granted, never reset. */
        extraRemaining: "+ {amount} {unit} on-demand",
        /** One account-wide pool behind several keys, never a per-key allowance. */
        shared: "account-wide",
        /** Semantic per-row labels derived from the normalized limit id's segment after the last ":". */
        window: {
          session: "Session",
          week: "Weekly",
          month: "Monthly",
          concurrency: "Concurrency",
          balance: "Balance",
        },
        /**
         * Fallback for a limit id whose segment is not a known semantic
         * bucket — the id segment is never rendered (it can be vendor
         * bucket text), so unknown rows get a numbered generic label.
         */
        limit: {
          generic: "Allowance {index}",
          genericSingle: "Allowance",
        },
        unit: { requests: "requests", credits: "credits", usd: "USD", tokens: "tokens", percent: "%" },
      },
    },
    providersCopy:
      "The providers configured for this App — stored keys show masked, custom declarations show their base URL and models. Add Provider picks a catalog entry; keys are stored only after a successful verify.",
    noConfiguredProviders:
      "No providers configured yet — use Add Provider to configure one. Reviews fail closed until a provider key is verified.",
    addProvider: "Add provider",
    addProviderCopy:
      "Pick a catalog provider — its configuration requirements appear once selected. Entries unusable under the App's runtime harness are marked and can't be saved; providers outside the catalog use the custom declaration below.",
    catalogProvenance:
      "{count} providers from the committed models.dev and omp snapshots, compiled into the app — no provider is contacted until you submit a key for verification.",
    catalogBuiltin: "Common providers",
    catalogTemplate: "Catalog templates",
    eligibilityBuiltin: "Works under the {image} runtime harness — this provider runs as a built-in.",
    eligibilityTemplate:
      "Works under the {image} runtime harness after materialization — your account id and key are saved as a custom provider declaration.",
    eligibilityUnavailable:
      "Not usable under the {image} runtime harness — the entry stays listed for discovery but cannot be configured for this App. Switch the App's runtime harness or use a custom declaration instead.",
    eligibilityUnavailableShort: "unavailable under {image}",
    configureProvider: "Configure {label}",
    customEntry: "Custom",
    customEntryCopy: "Declare a non-built-in provider — id, base URL, model ids, and key.",
    accountId: "Account id",
    accountIdPlaceholder: "32 hex characters",
    addTemplate: "Add {label}",
    modelChains: "Model chains",
    modelChainsCopy:
      "Default and named chains are peer tabs — edit each chain in its tab. The default chain is required and can't be removed; seats on a removed named chain fall back to the default.",
    addChain: "Add chain",
    chainName: "Chain name",
    chainNamePlaceholder: "e.g. deep-review",
    draftChain: "New chain",
    discardChain: "Discard",
    defaultChain: "Default chain",
    seats: "Seat chains",
    seatsCopy:
      "Each audit seat runs on the Default chain or an explicit named chain — a seat whose named chain was removed falls back to Default.",
    useDefaultChain: "Default chain",
    confirmRemoveChainTitle: "Remove chain {name}?",
    confirmRemoveChainBody: "Seats using {name} fall back to the default chain.",
    consoleOnly:
      "This provider can't be verified here — its endpoint has no fixed host, so this built-in row takes no key.",
    confirmRemoveKeyTitle: "Remove the {provider} key ending {last4}?",
    confirmRemoveKeyBody:
      "The App's other {provider} keys stay. Selectors that depend on this key alone fail until you verify a replacement.",
    confirmRemoveCustomTitle: "Remove provider {provider}?",
    confirmRemoveCustomBody:
      "The provider and every key in its pool are removed. To free one slot only, remove that key's own row. Chains referencing its models fail on save.",
    runtimeHarness: "Runtime harness",
    runtimeHarnessCopy:
      "The {id} runtime harness mounted into the sandbox image that executes this App's reviews. Reviews read their model configuration at run time — nothing App-specific is baked in.",
    runtimeHarnessValue: "This App's reviews run under the {id} runtime harness.",
    saveRuntimeHarness: "Save runtime harness",
    /**
     * GitHub identity card. `{name}`/`{id}`/`{time}` carry the
     * synced profile name, the numeric App id, and a relative synced-at time
     * (formatRelativeTime output) — nullable server fields degrade per-field,
     * so each key renders only when its value exists.
     */
    appInfo: "GitHub App",
    appInfoCopy:
      "The identity GitHub reports for this App. Profile fields are cached from the App's GitHub settings page; open the name to manage it there.",
    appInfoAppId: "App ID: {id}",
    // The local row id — the webhook URL's second segment, shown next to the
    // GitHub App id so both URL segments are readable from the card.
    appInfoLocalId: "Local App ID: {id}",
    // Manager-only: the absolute delivery URL a webhook repoint needs. The
    // deploy doc sends the operator to this card for it.
    appInfoDeliveryUrl: "Webhook URL:",
    appInfoViewOnGithub: "View {name} on GitHub",
    // (AD-623): the manager-face label — the name link targets the
    // App's GitHub settings page, so the accessible name says "manage", not
    // "view". Member face keeps appInfoViewOnGithub.
    appInfoManageOnGithub: "Manage {name} on GitHub",
    appInfoSynced: "Synced {time}",
    // Manager-only force refresh (D5): re-fetches the cached GitHub profile
    // bypassing the 24h TTL; the success notice confirms the cache reloaded.
    appInfoRefresh: "Refresh from GitHub",
    appInfoRefreshDone: "Identity refreshed from GitHub.",
    // Installed tab: the shareable GitHub installation entry point.
    install: "Install",
    installCopy: "Share this link with any GitHub account to install the App.",
    installLink: "Open the installation page",
    installLinkAria: "Install {name} on GitHub in a new tab",
    installNoSlug:
      "This App has no GitHub slug yet, so there is no installation link. Refresh the GitHub identity, then share the link.",
    // Installed tab: the owner allowlist (migration 0045).
    allowlist: "Owner allowlist",
    allowlistCopy: "With the switch on, only these repository owners are reviewed.",
    allowlistEnable: "Restrict reviews to allowlisted owners",
    allowlistOwners: "Allowed owners (one GitHub login per line)",
    allowlistFailClosed:
      "The switch is on and the list is empty: every delivery is refused, so no review will run.",
    allowlistPrivateStillApplies:
      "This App is private, but the stored list still applies to its deliveries — the control stays visible so you can manage it.",
    allowlistSave: "Save allowlist",
    // Settings tab: the review gate the Check reports (migration 0045).
    reviewGate: "Review gate",
    reviewGateCopy: "The Check passes only when the verdict is one of these and the score meets the floor.",
    reviewGateScore: "Minimum score (0–100)",
    reviewGateVerdicts: "Verdicts that pass",
    reviewGateFailClosed:
      "No verdict is selected: no review can ever pass, so every Check fails until you pick one.",
    reviewGateSave: "Save review gate",
    reviewGateUnreadable:
      "This App's stored review gate could not be read, so it cannot be edited here. The Check keeps failing closed until the stored configuration is repaired.",
    reviewGateReset: "Reset to the default gate (score {score}+, verdicts: {verdicts})",
  },
  manifest: {
    title: "Create GitHub App",
    start: {
      heading: "Create GitHub App",
      body:
        "Continue to GitHub to register {appName} with the review permissions and webhook for this Worker. GitHub shows the requested permissions first — nothing is created until you confirm there.",
      continue: "Continue on GitHub",
      cancel: "Cancel",
    },
    confirm: {
      heading: "Create GitHub App",
      ready: "GitHub App {appName} (id {id}) is ready to connect.",
      registeredAs: "It will be registered for this deployment as:",
      slugWebhook: "Slug {slug} · webhook URL {webhookUrl}",
      // Before the first metadata sync GitHub's slug is unknown; the App id is
      // the honest stand-in and says so, instead of borrowing the Slug label.
      appIdWebhook: "App ID {id} · webhook URL {webhookUrl}",
      note:
        "Connecting delivers this App's pull_request and issue_comment webhooks to this Worker. Reviews are controlled per App — pause an App to stop its reviews.",
      create: "Create App",
      cancel: "Cancel",
    },
    onboarding: {
      title: "GitHub App connected",
      heading: "GitHub App connected",
      connected: "GitHub App {appName} (id {id}) is connected to this deployment.",
      slug: "Slug: {slug}",
      // The NULL-slug face: what the page shows is the numeric App id, so the
      // label says so (the fallback must not hand the operator a number under
      // a "Slug" label).
      appId: "App ID: {id}",
      webhookUrl: "Webhook URL: {webhookUrl}",
      nextStep:
        "Next: open Settings and configure a provider — reviews begin once this App's provider key is verified and its models are picked.",
      openSettings: "Open Settings",
      dashboard: "Back to /dashboard",
    },
    error: {
      title: "GitHub App setup",
      failedHeading: "GitHub App setup failed.",
      secretsUnchanged: "No Worker secrets were changed.",
      resumable: "Your GitHub App is still held for retry — return to the confirmation page to resubmit.",
      confirmPage: "confirmation page",
      retry: "Return to /dashboard to try again.",
      stateMismatch: "The app-creation flow could not be verified (bad or expired state).",
      missingCode: "GitHub did not return an app-manifest code.",
      codeRejected: "GitHub rejected the app-manifest code.",
      loginMismatch:
        "This confirmation belongs to a different GitHub login — sign back in and restart the app-creation flow.",
      noEncryptionKey:
        "This deployment has no valid DASHBOARD_ENCRYPTION_KEY to store App credentials with — ask the operator to configure it, then resubmit.",
      alreadyConnected: "This GitHub App is already connected on this deployment — no changes were made.",
      dbRejected: "The App could not be stored — the dashboard database rejected the write. You can resubmit.",
      dbUnbound: "Dashboard storage is not configured — the App could not be stored.",
      /**
       * The workspace's stored default floor is untrusted: the connect fails
       * closed before writing anything, so the operator repairs the setting
       * and retries.
       */
      workspaceFloorUnreadable:
        "The App could not be connected — this workspace's default score floor cannot be read, so nothing was stored. Repair the setting, then resubmit.",
      /**
       * The workspace row came back without the floor field: the database
       * predates the column, so a settings visit cannot repair it. The copy
       * names the migration that adds it (`0049`).
       */
      workspaceFloorMalformed:
        "The App could not be connected — this workspace's row carries no default score floor, so nothing was stored. Apply migration 0049_workspace_check_min_score.sql, then resubmit.",
      /**
       * A transient read failure of the default floor: nothing was stored, and
       * resubmitting retries the read — there is no setting to repair.
       */
      workspaceFloorReadFailed:
        "The App could not be connected — this workspace's default score floor could not be read just now, so nothing was stored. Resubmit to retry.",
      /** The repair clause: "Repair it in [workspace settings]<floorRepairEnd>". */
      floorRepair: "Repair it in",
      floorRepairLink: "workspace settings",
      /** Ends the clause after the link, so the next sentence starts cleanly. */
      floorRepairEnd: ".",
      workspaceRequired:
        "This deployment has more than one workspace, so an App needs to know which it belongs to — open a workspace and create the App from there.",
      workspaceGone:
        "The workspace this App was created in no longer exists, so the App has no workspace page here — delete it on GitHub and start a new app-creation flow from a live workspace.",
    },
  },
  /**
   * Platform console (`/_internal_admin`) — the operator surface. Bilingual
   * through the same locale cookie as the workspace shell: `main.tsx` reads
   * `boot.locale`, every screen takes it as a prop, and page copy resolves
   * via `t(locale, …)`. These keys are operator-facing and never reuse the
   * tenant-facing `support.*` copy.
   */
  admin: {
    /** The document `<title>` — substituted server-side in `serveDocument`. */
    documentTitle: "Morning Star — Platform operations",
    /** The header/nav shell of `src/spa/admin/main.tsx`. */
    header: {
      title: "Platform operations",
      /** Shown under the title when the boot carries no login. */
      signedOut: "signed out",
      /** Link back to the operator's own workspace shell. */
      dashboardLink: "Workspace dashboard",
    },
    /** The console nav labels — `pages.ts` routes by `labelKey`. */
    nav: {
      flags: "Server flags",
      runtime: "Runtime parameters",
      workspaces: "Workspaces",
      users: "Users",
      supportGrants: "Support access",
    },
    /**
     * A refused console write: the page's generic failure message stays
     * primary and the server's own `{error}` text rides along as secondary
     * detail (PageNotice's single message string carries both).
     */
    refusalDetail: "Server: {detail}",
    /** Server flags page. */
    flags: {
      description:
        "Platform-wide switches. A change applies to the next request and appends one audit row.",
      loadFailed: "Could not load the server flags.",
      emptyTitle: "No flags",
      emptyDescription: "This server exposes no platform switch.",
      flagColumn: "Flag",
      effectColumn: "Effect when off",
      stateColumn: "State",
      /** State renders as ON/OFF in both locales (compass D9). */
      stateOn: "ON",
      stateOff: "OFF",
      /** The note under the review_global key (spec §3.1). */
      reviewGlobalNote: "Queued work is not cancelled.",
      noDocumentedEffect: "No documented effect.",
      /** What each flag governs while it is off, keyed by flag key. */
      effectReviewGlobal: "No new review is enqueued. The per-App pause switch is unchanged.",
      effectSignupOpen:
        "An unknown GitHub login cannot sign in for the first time. Existing accounts are unaffected.",
      effectWorkspaceCreationOpen:
        "No workspace can be created, the operator's own included.",
      /** Write confirmation dialog — {flag}, {from} and {to} (ON/OFF) are interpolated. */
      confirmTitle: "Turn {flag} from {from} to {to}?",
      confirmButton: "Confirm",
      cancelButton: "Cancel",
      /** Inline confirmation next to the row right after a successful write. */
      saved: "Saved.",
      /** Fallback when the write fails with an unrecognised error. */
      toggleFailed: "Could not change {flag}.",
      /** Toggle accessible name: "{flag} {state}" with the ON/OFF state. */
      stateAria: "{flag} {state}",
    },
    /** Runtime parameters page (iteration spec §1.1). */
    runtime: {
      description:
        "Non-secret runtime parameters. A change applies to the next review and appends one audit row.",
      loadFailed: "Could not load the runtime parameters.",
      concurrencyTitle: "System review concurrency",
      concurrencyDescription:
        "How many reviews the whole platform runs at once. Cloudflare Queues delivers at most 250 concurrently, so a value above that is a valid quota the platform cannot saturate.",
      concurrencyLabel: "Concurrent reviews",
      concurrencySave: "Save",
      concurrencySaved: "Saved.",
      /** Fallback when the write fails with an unrecognised error. */
      concurrencyFailed: "Could not change the system concurrency.",
      /** {value} = the cap currently stored (or the documented default). */
      concurrencyCurrent: "Effective on the next review: {value}.",
      /** The stored cap could not be read — the numbers are a fallback, not the stored setting. */
      concurrencyUnreadable:
        "The stored system concurrency could not be read, so every workspace is running one review at a time. Entering a value in range saves a new one, and retrying the read re-checks the stored row.",
      checkTitle: "Check budgets",
      checkDescription:
        "How long the review waits on its GitHub Check: the terminalize hook and the single terminal update. The review is never blocked past these bounds.",
      terminalizeLabel: "Terminalize hook (ms)",
      updateLabel: "Check update (ms)",
      checkSave: "Save",
      checkSaved: "Saved.",
      /** Fallback when the write fails with an unrecognised error. */
      checkFailed: "Could not change the check budgets.",
      /** {terminalize}/{update} = the budgets currently stored (or the documented defaults). */
      checkCurrent: "Effective on the next review: terminalize {terminalize} ms, update {update} ms.",
      /** Neither stored budget could be read — the numbers are the documented defaults. */
      checkUnreadable:
        "The stored check budgets could not be read, so the documented defaults are in use. Entering values in range saves new ones, and retrying the read re-checks the rows.",
      claimTitle: "Comment-trigger recovery",
      claimDescription:
        "How the cron recovers a bot-mention comment whose queue send never happened: how long a claimed comment waits before it is re-sent, how many attempts it gets, and how many claims one sweep re-sends.",
      retryLabel: "Retry window (ms)",
      attemptsLabel: "Max attempts",
      outboxLabel: "Outbox batch",
      claimSave: "Save",
      claimSaved: "Saved.",
      /** Fallback when the write fails with an unrecognised error. */
      claimFailed: "Could not change the comment-trigger recovery settings.",
      /** {retry}/{attempts}/{outbox} = the stored settings (or the documented defaults). */
      claimCurrent:
        "Effective on the next sweep: retry after {retry} ms, {attempts} attempts, {outbox} claims per sweep.",
      /** No stored setting could be read — the numbers are the documented defaults. */
      claimUnreadable:
        "The stored comment-trigger recovery settings could not be read, so the documented defaults are in use. Entering values in range saves new ones, and retrying the read re-checks the rows.",
      /** The operator default an App without its own depth inherits. */
      reviewLevelTitle: "Review depth",
      reviewLevelDescription: "Applies to Apps that have not chosen their own review depth.",
      reviewLevelLabel: "Default review depth",
      reviewLevelQuick: "Quick — fast, single-pass review",
      reviewLevelStandard: "Standard — balanced depth (recommended)",
      reviewLevelDeep: "Deep — most thorough, slower",
      reviewLevelSave: "Save",
      reviewLevelSaved: "Saved.",
      /** Fallback when the write fails with an unrecognised error. */
      reviewLevelFailed: "Could not change the default review depth.",
      /** The stored level could not be read — the shown tier is the documented default. */
      reviewLevelUnreadable:
        "The stored default review depth could not be read, so Apps without their own depth run Standard. Choosing a level saves a new one, and retrying the read re-checks the row.",
      /** The prior-findings seat's ask budget. */
      recheckTitle: "Recheck assignment budget",
      recheckDescription:
        "How much of a round the prior-findings seat is asked with, in UTF-8 bytes. Every prior finding and the discussion always ride; evidence slices ride until this budget is spent.",
      recheckLabel: "Assignment budget (bytes)",
      recheckSave: "Save",
      recheckSaved: "Saved.",
      /** Fallback when the write fails with an unrecognised error. */
      recheckFailed: "Could not change the recheck assignment budget.",
      /** {value} = the budget currently stored (or the documented default). */
      recheckCurrent: "Effective on the next review: {value} bytes.",
      /** The stored budget could not be read — the number is the documented default. */
      recheckUnreadable:
        "The stored recheck assignment budget could not be read, so the documented default is in use. Entering a value in range saves a new one, and retrying the read re-checks the row.",
      /** Admission refusals the pipeline recorded over the trailing 24h. */
      admissionDropsTitle: "Admission drops (last 24 hours)",
      admissionDropsDescription:
        "Reviews the pipeline refused to admit, counted by reason. A dropped review never started; the counts read the failure rows the pipeline already writes.",
      /** Why an admission was refused: the PR lock, a cap, or a storage fault. */
      admissionDropsPrHeld: "PR in flight",
      admissionDropsSystemCap: "System cap",
      admissionDropsWorkspaceCap: "Workspace cap",
      admissionDropsError: "Storage error",
      /** The live queue gauge plus the 24 h GitHub secondary-rate-limit count. */
      queueTitle: "Queue backlog and GitHub rate limits",
      queueDescription:
        "The live review-queue gauge and the GitHub secondary-limit rejections the pipeline recorded over the last 24 hours. A reading of “not readable” means the gauge could not be asked — never that the queue is empty.",
      queueBacklogLabel: "Backlog depth",
      queueOldestLabel: "Oldest message",
      queueUnreadable: "Not readable",
      /** No message is waiting, so the gauge reports no oldest stamp. */
      queueEmpty: "Empty",
      githubRateLimitedLabel: "GitHub secondary limits (24 h)",
      /**
       * Deployment version footer. `{version}` carries the
       * v-prefixed display form (`v${APP_VERSION}`) — the same shape as the
       * /healthz field and release tags.
       */
      version: "Version {version}",
    },
    /** Workspaces page. */
    workspaces: {
      description:
        "Every live workspace. A plan change never removes a member; a downgrade only blocks new invites.",
      loadFailed: "Could not load the workspace list.",
      emptyTitle: "No workspaces",
      emptyDescription: "This deployment has no live workspace yet.",
      workspaceColumn: "Workspace",
      ownerColumn: "Owner",
      membersColumn: "Members",
      /** {count} = pending invite count (rendered only when > 0). */
      pendingInvites: "{count} pending",
      seatsColumn: "Seats",
      planColumn: "Plan",
      createdColumn: "Created",
      /** Fallback when the plan write fails with an unrecognised error. */
      planChangeFailed: "Could not change the plan for {name}.",
      /** The plan picker's accessible name. */
      planAria: "Plan for {name}",
      /** The plan picker's catalogue labels, keyed by the wire plan id. */
      planFree: "Free",
      planPro: "Pro",
      planUnlimited: "Unlimited",
      /** Row action that opens the slug dialog. */
      slugAction: "Edit slug",
      /** The row action's accessible name. */
      slugAria: "Edit the slug of {name}",
      slugDialogTitle: "Workspace URL slug",
      slugDialogDescription:
        "The readable part of this workspace's dashboard URL. Lowercase letters, digits and hyphens, 2–39 characters, starting with a letter or digit. The owner can no longer change it.",
      slugLabel: "Slug",
      slugSave: "Save slug",
      cancelAction: "Cancel",
      /** Fallback when the slug write fails with an unrecognised error. */
      slugChangeFailed: "Could not change the slug for {name}.",
    },
    /** Users page. */
    users: {
      description:
        "Every account on this platform. Read-only: operator status comes from the allowlist, support access from the grant list.",
      loadFailed: "Could not load the user list.",
      emptyTitle: "No users",
      emptyDescription: "Nobody has signed in to this platform yet.",
      githubColumn: "GitHub",
      firstSeenColumn: "First seen",
      workspacesColumn: "Workspaces",
      identityColumn: "Identity",
      identityOperator: "Operator",
      /** {count} = the login's live grant count. */
      identitySupport: "Support ({count})",
      identityUser: "User",
    },
    /**
     * Client-side table search (Workspaces, Users): one input filters the
     * already-loaded rows; the counter reads "shown / total".
     */
    search: {
      placeholder: "Search",
      /** {shown} = matching rows, {total} = loaded rows. */
      counter: "{shown} / {total}",
      emptyTitle: "No matches",
      emptyDescription: "No row matches the current search.",
    },
    /** Support grants page — list heads and the create form. */
    supportGrants: {
      description:
        "Time-boxed cross-workspace access. Creating and revoking a grant each append one audit row.",
      loadFailed: "Could not load the support grants.",
      /** Fallback when a write fails with an unrecognised error. */
      createFailed: "Could not create the support grant.",
      revokeFailed: "Could not revoke the support grant.",
      newWindowTitle: "New support window",
      workspaceLabel: "Workspace",
      workspacePlaceholder: "Select a workspace",
      operatorLabel: "Operator login",
      operatorPlaceholder: "octocat",
      reasonLabel: "Reason",
      reasonPlaceholder: "incident 42",
      hoursLabel: "Hours",
      submit: "Grant access",
      operatorColumn: "Operator",
      workspaceColumn: "Workspace",
      reasonColumn: "Reason",
      expiresColumn: "Expires",
      revokeAction: "Revoke",
      emptyTitle: "No open support windows",
      emptyDescription: "No operator holds cross-workspace access right now.",
    },
  },
};

/** The dictionary shape — derived from en, the source of truth. */
export type Dictionary = typeof en;
